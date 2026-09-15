//! A small, disposable, self-validating content-addressed fact cache.

use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use parking_lot::RwLock;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    identity::FileFactKey,
    limits::{
        MAX_CACHE_BYTES, MAX_CACHE_ENTRY_BYTES, MAX_MEMORY_CACHE_BYTES, MAX_MEMORY_CACHE_ENTRIES,
    },
    model::{CacheMetadata, FileFacts},
};

const MAGIC: &[u8; 8] = b"OPZFACT\0";
const HEADER_BYTES: usize = 8 + 2 + 32 + 8 + 32;
const SCHEMA_VERSION: u16 = 1;
const GC_INTERVAL_BYTES: u64 = 8 * 1024 * 1024;
const GC_MIN_INTERVAL: Duration = Duration::from_secs(30);
const ABANDONED_TEMP_AGE: Duration = Duration::from_mins(10);

#[derive(Debug, Error)]
pub enum CacheError {
    #[error("invalid cache root: {0}")]
    InvalidRoot(String),
    #[error("cache I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("cache serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("fact payload exceeds the cache entry limit")]
    TooLarge,
    #[error("same fact key produced unequal deterministic payloads")]
    NonDeterministic,
}

pub trait FactCache: Send + Sync {
    fn get(&self, key: FileFactKey) -> Result<Option<Arc<FileFacts>>, CacheError>;
    fn put(&self, key: FileFactKey, facts: Arc<FileFacts>) -> Result<(), CacheError>;
    fn metadata(&self) -> CacheMetadata;
}

#[must_use]
pub(crate) fn metadata_delta(before: &CacheMetadata, after: CacheMetadata) -> CacheMetadata {
    CacheMetadata {
        state: after.state,
        hits: after.hits.saturating_sub(before.hits),
        misses: after.misses.saturating_sub(before.misses),
        writes: after.writes.saturating_sub(before.writes),
    }
}

#[derive(Default)]
struct Counters {
    hits: AtomicUsize,
    misses: AtomicUsize,
    writes: AtomicUsize,
}

impl Counters {
    fn metadata(&self, state: &str) -> CacheMetadata {
        CacheMetadata {
            state: state.into(),
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
            writes: self.writes.load(Ordering::Relaxed),
        }
    }
}

#[derive(Default)]
pub struct MemoryFactCache {
    state: RwLock<MemoryState>,
    counters: Counters,
}

#[derive(Default)]
struct MemoryState {
    entries: HashMap<FileFactKey, (Arc<FileFacts>, usize)>,
    insertion_order: VecDeque<FileFactKey>,
    bytes: usize,
}

impl MemoryFactCache {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl FactCache for MemoryFactCache {
    fn get(&self, key: FileFactKey) -> Result<Option<Arc<FileFacts>>, CacheError> {
        let result = self
            .state
            .read()
            .entries
            .get(&key)
            .map(|(facts, _)| Arc::clone(facts));
        if result.is_some() {
            self.counters.hits.fetch_add(1, Ordering::Relaxed);
        } else {
            self.counters.misses.fetch_add(1, Ordering::Relaxed);
        }
        Ok(result)
    }

    fn put(&self, key: FileFactKey, facts: Arc<FileFacts>) -> Result<(), CacheError> {
        let payload_bytes = serde_json::to_vec(facts.as_ref())?.len();
        if payload_bytes > MAX_MEMORY_CACHE_BYTES {
            return Ok(());
        }
        let mut state = self.state.write();
        if let Some((existing, _)) = state.entries.get(&key) {
            if existing.as_ref() != facts.as_ref() {
                return Err(CacheError::NonDeterministic);
            }
            return Ok(());
        }
        while state.entries.len() >= MAX_MEMORY_CACHE_ENTRIES
            || state.bytes.saturating_add(payload_bytes) > MAX_MEMORY_CACHE_BYTES
        {
            let Some(oldest) = state.insertion_order.pop_front() else {
                break;
            };
            if let Some((_, size)) = state.entries.remove(&oldest) {
                state.bytes = state.bytes.saturating_sub(size);
            }
        }
        state.entries.insert(key, (facts, payload_bytes));
        state.insertion_order.push_back(key);
        state.bytes = state.bytes.saturating_add(payload_bytes);
        self.counters.writes.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    fn metadata(&self) -> CacheMetadata {
        self.counters.metadata("memory")
    }
}

pub struct PersistentFactCache {
    root: PathBuf,
    counters: Counters,
    bytes_since_gc: [AtomicU64; 16],
}

impl PersistentFactCache {
    pub fn open(root: &Path, forbidden_roots: &[&Path]) -> Result<Self, CacheError> {
        require_absolute(root)?;
        validate_root_location(root, forbidden_roots)?;
        reject_root_symlink(root)?;
        fs::create_dir_all(root)?;
        let root = root.canonicalize()?;
        validate_root_location(&root, forbidden_roots)?;
        secure_cache_root(&root)?;
        fs::create_dir_all(root.join("facts"))?;
        Ok(Self {
            root,
            counters: Counters::default(),
            bytes_since_gc: std::array::from_fn(|_| AtomicU64::new(GC_INTERVAL_BYTES)),
        })
    }

    fn path_for(&self, key: FileFactKey) -> PathBuf {
        self.paths_for(key).1
    }

    fn paths_for(&self, key: FileFactKey) -> (PathBuf, PathBuf) {
        let hex = key.hex();
        let shard = self.root.join("facts").join(&hex[..1]);
        let destination = shard.join(format!("{}.fact", &hex[1..]));
        (shard, destination)
    }

    fn read_payload(path: &Path, key: FileFactKey) -> Result<Option<Vec<u8>>, CacheError> {
        let Some(mut file) = open_optional(path)? else {
            return Ok(None);
        };
        let metadata = file.metadata()?;
        if !valid_fact_metadata(&metadata) {
            return Ok(None);
        }
        let Some(header) = read_header(&mut file) else {
            return Ok(None);
        };
        let Some(length) = payload_length(&header, &metadata, key) else {
            return Ok(None);
        };
        let Some(payload) = read_exact_payload(&mut file, length) else {
            return Ok(None);
        };
        if !checksum_matches(&payload, &header) {
            return Ok(None);
        }
        Ok(Some(payload))
    }
}

impl FactCache for PersistentFactCache {
    fn get(&self, key: FileFactKey) -> Result<Option<Arc<FileFacts>>, CacheError> {
        let payload = Self::read_payload(&self.path_for(key), key)?;
        let result = payload
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .map(Arc::new);
        if result.is_some() {
            self.counters.hits.fetch_add(1, Ordering::Relaxed);
        } else {
            self.counters.misses.fetch_add(1, Ordering::Relaxed);
        }
        Ok(result)
    }

    fn put(&self, key: FileFactKey, facts: Arc<FileFacts>) -> Result<(), CacheError> {
        let payload = serde_json::to_vec(facts.as_ref())?;
        if payload.len() > MAX_CACHE_ENTRY_BYTES {
            return Err(CacheError::TooLarge);
        }
        let (parent, destination) = self.paths_for(key);
        fs::create_dir_all(&parent)?;
        match existing_fact(&destination, key, &payload)? {
            ExistingFact::Matching => return Ok(()),
            ExistingFact::Conflicting => return Err(CacheError::NonDeterministic),
            ExistingFact::Missing => {}
        }
        let temporary = write_temporary_fact(&parent, key, &payload)?;
        self.publish(key, &parent, &destination, temporary, &payload)
    }

    fn metadata(&self) -> CacheMetadata {
        self.counters.metadata("persistent")
    }
}

impl PersistentFactCache {
    fn publish(
        &self,
        key: FileFactKey,
        shard: &Path,
        destination: &Path,
        temporary: tempfile::NamedTempFile,
        payload: &[u8],
    ) -> Result<(), CacheError> {
        match temporary.persist_noclobber(destination) {
            Ok(_) => {
                self.counters.writes.fetch_add(1, Ordering::Relaxed);
                self.maybe_enforce_shard_quota(key, shard, allocated_path_bytes(destination));
                Ok(())
            }
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                match existing_fact(destination, key, payload)? {
                    ExistingFact::Matching => Ok(()),
                    ExistingFact::Conflicting => Err(CacheError::NonDeterministic),
                    ExistingFact::Missing => {
                        self.repair_and_publish(key, shard, destination, error.file, payload)
                    }
                }
            }
            Err(error) => Err(error.error.into()),
        }
    }
    fn repair_and_publish(
        &self,
        key: FileFactKey,
        shard: &Path,
        destination: &Path,
        temporary: tempfile::NamedTempFile,
        payload: &[u8],
    ) -> Result<(), CacheError> {
        let Some(lock) = try_lock_shard(shard)? else {
            return Ok(());
        };
        match existing_fact(destination, key, payload)? {
            ExistingFact::Matching => return Ok(()),
            ExistingFact::Conflicting => return Err(CacheError::NonDeterministic),
            ExistingFact::Missing => {}
        }
        remove_invalid_fact_path(destination)?;
        self.finish_repair(
            temporary,
            RepairPublication {
                key,
                shard,
                destination,
                payload,
                lock,
            },
        )
    }

    fn finish_repair(
        &self,
        temporary: tempfile::NamedTempFile,
        publication: RepairPublication<'_>,
    ) -> Result<(), CacheError> {
        match temporary.persist_noclobber(publication.destination) {
            Ok(_) => {
                self.counters.writes.fetch_add(1, Ordering::Relaxed);
                let written = allocated_path_bytes(publication.destination);
                drop(publication.lock);
                self.maybe_enforce_shard_quota(publication.key, publication.shard, written);
                Ok(())
            }
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                match existing_fact(
                    publication.destination,
                    publication.key,
                    publication.payload,
                )? {
                    ExistingFact::Matching => Ok(()),
                    ExistingFact::Conflicting => Err(CacheError::NonDeterministic),
                    ExistingFact::Missing => Err(error.error.into()),
                }
            }
            Err(error) => Err(error.error.into()),
        }
    }

    fn maybe_enforce_shard_quota(&self, key: FileFactKey, shard: &Path, written: u64) {
        let shard_index = usize::from(key.as_bytes()[0] >> 4);
        let counter = &self.bytes_since_gc[shard_index];
        let pending = counter
            .fetch_add(written, Ordering::Relaxed)
            .saturating_add(written);
        if pending < GC_INTERVAL_BYTES {
            return;
        }
        match enforce_shard_quota(shard) {
            QuotaCheck::Checked | QuotaCheck::Recent => counter.store(0, Ordering::Relaxed),
            QuotaCheck::Contended => counter.store(GC_INTERVAL_BYTES, Ordering::Relaxed),
        }
    }
}

struct RepairPublication<'a> {
    key: FileFactKey,
    shard: &'a Path,
    destination: &'a Path,
    payload: &'a [u8],
    lock: File,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ExistingFact {
    Missing,
    Matching,
    Conflicting,
}

fn existing_fact(
    path: &Path,
    key: FileFactKey,
    payload: &[u8],
) -> Result<ExistingFact, CacheError> {
    Ok(match PersistentFactCache::read_payload(path, key)? {
        Some(existing) if existing == payload => ExistingFact::Matching,
        Some(_) => ExistingFact::Conflicting,
        None => ExistingFact::Missing,
    })
}

fn write_temporary_fact(
    shard: &Path,
    key: FileFactKey,
    payload: &[u8],
) -> Result<tempfile::NamedTempFile, CacheError> {
    let mut temporary = tempfile::Builder::new()
        .prefix(".fact-")
        .tempfile_in(shard)?;
    secure_temporary(&temporary)?;
    let checksum: [u8; 32] = Sha256::digest(payload).into();
    temporary.write_all(MAGIC)?;
    temporary.write_all(&SCHEMA_VERSION.to_be_bytes())?;
    temporary.write_all(key.as_bytes())?;
    temporary.write_all(&(payload.len() as u64).to_be_bytes())?;
    temporary.write_all(&checksum)?;
    temporary.write_all(payload)?;
    Ok(temporary)
}

#[cfg(unix)]
fn secure_temporary(temporary: &tempfile::NamedTempFile) -> Result<(), CacheError> {
    use std::os::unix::fs::PermissionsExt;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn secure_temporary(_temporary: &tempfile::NamedTempFile) -> Result<(), CacheError> {
    Ok(())
}

fn require_absolute(root: &Path) -> Result<(), CacheError> {
    if root.is_absolute() {
        Ok(())
    } else {
        Err(CacheError::InvalidRoot("path must be absolute".into()))
    }
}

fn reject_root_symlink(root: &Path) -> Result<(), CacheError> {
    if root
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        Err(CacheError::InvalidRoot("root must not be a symlink".into()))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn secure_cache_root(root: &Path) -> Result<(), CacheError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(root)?.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn secure_cache_root(_root: &Path) -> Result<(), CacheError> {
    Ok(())
}

fn open_optional(path: &Path) -> Result<Option<File>, CacheError> {
    match File::open(path) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn valid_fact_metadata(metadata: &fs::Metadata) -> bool {
    let max_len = (HEADER_BYTES + MAX_CACHE_ENTRY_BYTES) as u64;
    metadata.is_file() && metadata.len() >= HEADER_BYTES as u64 && metadata.len() <= max_len
}

fn read_header(file: &mut File) -> Option<[u8; HEADER_BYTES]> {
    let mut header = [0u8; HEADER_BYTES];
    (file.read_exact(&mut header).is_ok() && &header[..8] == MAGIC).then_some(header)
}

fn payload_length(
    header: &[u8; HEADER_BYTES],
    metadata: &fs::Metadata,
    key: FileFactKey,
) -> Option<usize> {
    if u16::from_be_bytes([header[8], header[9]]) != SCHEMA_VERSION
        || &header[10..42] != key.as_bytes()
    {
        return None;
    }
    let length_bytes: [u8; 8] = header[42..50].try_into().ok()?;
    let encoded = u64::from_be_bytes(length_bytes);
    let length = usize::try_from(encoded).ok()?;
    (length <= MAX_CACHE_ENTRY_BYTES && metadata.len() == (HEADER_BYTES + length) as u64)
        .then_some(length)
}

fn read_exact_payload(file: &mut File, length: usize) -> Option<Vec<u8>> {
    let mut payload = vec![0; length];
    file.read_exact(&mut payload).is_ok().then_some(payload)
}

fn checksum_matches(payload: &[u8], header: &[u8; HEADER_BYTES]) -> bool {
    let checksum: [u8; 32] = Sha256::digest(payload).into();
    checksum.as_slice() == &header[50..82]
}

enum QuotaCheck {
    Checked,
    Recent,
    Contended,
}

fn enforce_shard_quota(shard: &Path) -> QuotaCheck {
    let Ok(Some(mut lock)) = try_lock_shard(shard) else {
        return QuotaCheck::Contended;
    };
    if quota_recently_checked(&lock) {
        return QuotaCheck::Recent;
    }
    let per_shard = MAX_CACHE_BYTES / 16;
    let (entries, total) = scan_shard(shard);
    trim_shard(entries, total, per_shard);
    let _ = lock.set_len(0);
    let _ = lock.write_all(b"checked");
    QuotaCheck::Checked
}

type CacheEntry = (Option<std::time::SystemTime>, PathBuf, u64);

fn quota_recently_checked(lock: &File) -> bool {
    lock.metadata().ok().is_some_and(|metadata| {
        metadata.len() > 0
            && metadata
                .modified()
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age < GC_MIN_INTERVAL)
    })
}

fn scan_shard(shard: &Path) -> (Vec<CacheEntry>, u64) {
    let mut entries = Vec::new();
    let mut total = 0u64;
    let Ok(directory) = fs::read_dir(shard) else {
        return (entries, total);
    };
    for entry in directory.flatten() {
        if let Some(cache_entry) = classify_cache_entry(entry.path()) {
            total = total.saturating_add(cache_entry.2);
            entries.push(cache_entry);
        }
    }
    (entries, total)
}

fn classify_cache_entry(path: PathBuf) -> Option<CacheEntry> {
    let metadata = path.symlink_metadata().ok()?;
    if is_temporary_fact(&path) {
        remove_abandoned_temporary(&path, &metadata);
        return None;
    }
    if path.extension().and_then(|value| value.to_str()) != Some("fact")
        || !metadata.is_file()
        || metadata.file_type().is_symlink()
    {
        return None;
    }
    Some((metadata.modified().ok(), path, allocated_bytes(&metadata)))
}

fn is_temporary_fact(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".fact-"))
}

fn remove_abandoned_temporary(path: &Path, metadata: &fs::Metadata) {
    let abandoned = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age >= ABANDONED_TEMP_AGE);
    if abandoned {
        let _ = fs::remove_file(path);
    }
}

fn trim_shard(mut entries: Vec<CacheEntry>, mut total: u64, limit: u64) {
    if total <= limit {
        return;
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let target = limit.saturating_mul(9) / 10;
    for (_, path, size) in entries {
        if total <= target {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn try_lock_shard(shard: &Path) -> std::io::Result<Option<File>> {
    let path = shard.join(".quota.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(path)?;
    match fs2::FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(Some(file)),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
        Err(error) => Err(error),
    }
}

fn remove_invalid_fact_path(path: &Path) -> std::io::Result<()> {
    let metadata = path.symlink_metadata()?;
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::other("cache fact path is a symlink"));
    }
    if metadata.is_dir() {
        fs::remove_dir(path)
    } else if metadata.is_file() {
        fs::remove_file(path)
    } else {
        Err(std::io::Error::other(
            "cache fact path is not a regular file or empty directory",
        ))
    }
}

fn allocated_path_bytes(path: &Path) -> u64 {
    path.metadata()
        .map_or(0, |metadata| allocated_bytes(&metadata))
}

#[cfg(unix)]
fn allocated_bytes(metadata: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.blocks().saturating_mul(512)
}

#[cfg(not(unix))]
fn allocated_bytes(metadata: &fs::Metadata) -> u64 {
    metadata.len()
}

fn validate_root_location(root: &Path, forbidden_roots: &[&Path]) -> Result<(), CacheError> {
    let candidate = resolved_candidate(root)?;
    for forbidden in forbidden_roots {
        reject_overlap(&candidate, forbidden)?;
    }
    Ok(())
}

fn resolved_candidate(root: &Path) -> Result<PathBuf, CacheError> {
    let existing = root
        .ancestors()
        .find(|ancestor| ancestor.exists())
        .ok_or_else(|| CacheError::InvalidRoot("path has no existing ancestor".into()))?;
    let mut candidate = existing.canonicalize()?;
    for component in root
        .strip_prefix(existing)
        .map_err(|error| CacheError::InvalidRoot(error.to_string()))?
        .components()
    {
        match component {
            std::path::Component::Normal(component) => candidate.push(component),
            _ => {
                return Err(CacheError::InvalidRoot(
                    "path must not contain relative components".into(),
                ));
            }
        }
    }
    Ok(candidate)
}

fn reject_overlap(candidate: &Path, forbidden: &Path) -> Result<(), CacheError> {
    let Ok(forbidden) = forbidden.canonicalize() else {
        return Ok(());
    };
    if candidate.starts_with(&forbidden) || forbidden.starts_with(candidate) {
        return Err(CacheError::InvalidRoot(format!(
            "{} overlaps forbidden tree {}",
            candidate.display(),
            forbidden.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;

    fn key(seed: &[u8]) -> FileFactKey {
        FileFactKey::from_bytes(crate::identity::hash_domain("test-fact", &[seed]))
    }

    #[test]
    fn persistent_cache_round_trips_and_repairs_corruption() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("cache");
        let cache = PersistentFactCache::open(&root, &[]).unwrap();
        let facts = Arc::new(FileFacts {
            parser: "p".into(),
            parser_version: "1".into(),
            ..FileFacts::default()
        });
        cache.put(key(b"a"), Arc::clone(&facts)).unwrap();
        assert_eq!(cache.get(key(b"a")).unwrap(), Some(Arc::clone(&facts)));
        OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(cache.path_for(key(b"a")))
            .unwrap()
            .write_all(b"bad")
            .unwrap();
        assert_eq!(cache.get(key(b"a")).unwrap(), None);
        cache.put(key(b"a"), Arc::clone(&facts)).unwrap();
        assert_eq!(cache.get(key(b"a")).unwrap(), Some(facts));
    }

    #[test]
    fn rejects_roots_inside_candidate_tree() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("cache");
        assert!(PersistentFactCache::open(&root, &[temp.path()]).is_err());
        assert!(
            !root.exists(),
            "validation must happen before creating cache directories"
        );
    }

    #[test]
    fn concurrent_equal_writers_publish_one_valid_fact() {
        let temp = tempfile::tempdir().unwrap();
        let cache = Arc::new(PersistentFactCache::open(&temp.path().join("cache"), &[]).unwrap());
        let facts = Arc::new(FileFacts {
            parser: "p".into(),
            parser_version: "1".into(),
            ..FileFacts::default()
        });
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let cache = Arc::clone(&cache);
                let facts = Arc::clone(&facts);
                std::thread::spawn(move || cache.put(key(b"shared"), facts))
            })
            .collect();
        for thread in threads {
            thread.join().unwrap().unwrap();
        }
        assert_eq!(cache.get(key(b"shared")).unwrap(), Some(facts));
        assert_eq!(cache.metadata().writes, 1);
    }

    #[test]
    fn repairs_an_empty_directory_at_a_fact_path() {
        let temp = tempfile::tempdir().unwrap();
        let cache = PersistentFactCache::open(&temp.path().join("cache"), &[]).unwrap();
        let fact_key = key(b"wrong-type");
        let facts = Arc::new(FileFacts {
            parser: "p".into(),
            parser_version: "1".into(),
            ..FileFacts::default()
        });
        cache.put(fact_key, Arc::clone(&facts)).unwrap();
        let path = cache.path_for(fact_key);
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(cache.get(fact_key).unwrap(), None);
        cache.put(fact_key, Arc::clone(&facts)).unwrap();
        assert_eq!(cache.get(fact_key).unwrap(), Some(facts));
        assert!(path.is_file());
    }

    #[test]
    fn wrong_schema_and_abandoned_temp_are_safe_misses() {
        let temp = tempfile::tempdir().unwrap();
        let cache = PersistentFactCache::open(&temp.path().join("cache"), &[]).unwrap();
        let facts = Arc::new(FileFacts {
            parser: "p".into(),
            parser_version: "1".into(),
            ..FileFacts::default()
        });
        cache.put(key(b"schema"), facts).unwrap();
        let path = cache.path_for(key(b"schema"));
        let mut bytes = fs::read(&path).unwrap();
        bytes[8..10].copy_from_slice(&99u16.to_be_bytes());
        fs::write(path, bytes).unwrap();
        fs::write(cache.root.join("facts").join(".fact-abandoned"), b"partial").unwrap();
        assert_eq!(cache.get(key(b"schema")).unwrap(), None);
        assert_eq!(cache.get(key(b"absent")).unwrap(), None);
    }

    #[test]
    fn memory_cache_returns_shared_facts_without_cloning() {
        let cache = MemoryFactCache::new();
        let fact_key = key(b"shared-memory");
        let facts = Arc::new(FileFacts {
            parser: "p".into(),
            parser_version: "1".into(),
            ..FileFacts::default()
        });
        cache.put(fact_key, Arc::clone(&facts)).unwrap();
        let loaded = cache.get(fact_key).unwrap().unwrap();

        assert!(Arc::ptr_eq(&facts, &loaded));
    }

    #[test]
    fn quota_evicts_the_oldest_fact_and_accounts_allocated_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let cache = PersistentFactCache::open(&temp.path().join("cache"), &[]).unwrap();
        let mut by_shard: [Vec<FileFactKey>; 16] = std::array::from_fn(|_| Vec::new());
        let fact_keys = (0u64..)
            .find_map(|candidate| {
                let fact_key = key(&candidate.to_be_bytes());
                let shard = usize::from(fact_key.as_bytes()[0] >> 4);
                by_shard[shard].push(fact_key);
                (by_shard[shard].len() == 3).then(|| std::mem::take(&mut by_shard[shard]))
            })
            .unwrap();
        let facts: Vec<_> = (0..3)
            .map(|index| {
                Arc::new(FileFacts {
                    parser: format!("parser-{index}"),
                    parser_version: "1".into(),
                    ..FileFacts::default()
                })
            })
            .collect();
        for (&fact_key, fact) in fact_keys.iter().zip(&facts) {
            cache.put(fact_key, Arc::clone(fact)).unwrap();
        }

        let now = std::time::SystemTime::now();
        let paths: Vec<_> = fact_keys.iter().map(|&key| cache.path_for(key)).collect();
        for (index, path) in paths.iter().enumerate() {
            let modified = now - Duration::from_secs(30 - index as u64);
            File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(modified))
                .unwrap();
        }
        let shard = paths[0].parent().unwrap();
        let abandoned = shard.join(".fact-abandoned");
        fs::write(&abandoned, b"partial").unwrap();
        File::options()
            .write(true)
            .open(&abandoned)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(now - ABANDONED_TEMP_AGE - Duration::from_secs(1)),
            )
            .unwrap();

        let expected_sizes: Vec<_> = paths
            .iter()
            .map(|path| allocated_path_bytes(path))
            .collect();
        let expected_total: u64 = expected_sizes.iter().sum();
        let (entries, total) = scan_shard(shard);
        assert_eq!(total, expected_total);
        assert!(!abandoned.exists());
        let retained_bytes = expected_sizes[1].saturating_add(expected_sizes[2]);
        let limit = retained_bytes.saturating_mul(10).div_ceil(9);
        assert!(total > limit);

        trim_shard(entries, total, limit);

        let (_, remaining_bytes) = scan_shard(shard);
        assert_eq!(remaining_bytes, retained_bytes);
        assert_eq!(cache.get(fact_keys[0]).unwrap(), None);
        assert_eq!(
            cache.get(fact_keys[1]).unwrap(),
            Some(Arc::clone(&facts[1]))
        );
        assert_eq!(
            cache.get(fact_keys[2]).unwrap(),
            Some(Arc::clone(&facts[2]))
        );
    }
}
