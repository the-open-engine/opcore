use ruff_python_ast::token::{TokenKind, Tokens};
use ruff_python_parser::{Mode, lexer};
use ruff_text_size::Ranged;

use crate::{
    analysis::AnalysisError,
    cancel::{CANCELLATION_POLL_INTERVAL, CancelToken},
    limits::MAX_STRUCTURAL_DEPTH,
};

use super::cancellation_boundary;

pub(super) const UTF8_BOM: &[u8] = b"\xef\xbb\xbf";

pub(super) fn preflight_structure(source: &str, cancel: &CancelToken) -> Result<(), AnalysisError> {
    let mut structure = PythonStructure::default();
    let mut tokens = lexer::lex(source, Mode::Module);
    let mut index = 0usize;
    loop {
        if index.is_multiple_of(CANCELLATION_POLL_INTERVAL) {
            cancellation_boundary(cancel)?;
        }
        let token = tokens.next_token();
        if token.is_eof() {
            break;
        }
        index = index.saturating_add(1);
        if structure.ignore_or_reset(token) {
            continue;
        }
        if structure.observe_layout(token) {
            continue;
        }
        structure.observe_line_start(token);
        structure.observe_expression(token);
        structure.observe_unary(token);
        structure.validate()?;
    }
    drop(tokens.finish());
    Ok(())
}

#[derive(Clone, Copy)]
pub(super) struct PythonFingerprintToken {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) tag: u8,
}

pub(super) fn fingerprint_tokens(tokens: &Tokens) -> Vec<PythonFingerprintToken> {
    tokens
        .iter()
        .filter_map(|token| {
            python_fingerprint_tag(token.kind()).map(|tag| PythonFingerprintToken {
                start: token.start().to_usize(),
                end: token.end().to_usize(),
                tag,
            })
        })
        .collect()
}

const fn python_fingerprint_tag(token: TokenKind) -> Option<u8> {
    match token {
        TokenKind::Comment | TokenKind::NonLogicalNewline | TokenKind::EndOfFile => None,
        TokenKind::Indent => Some(1),
        TokenKind::Dedent => Some(2),
        TokenKind::Newline => Some(3),
        _ => Some(0),
    }
}

struct PythonStructure {
    delimiters: usize,
    indents: usize,
    unary: usize,
    expression_nodes: usize,
    logical_line_start: bool,
    elif_chain_by_indent: Vec<usize>,
}

impl Default for PythonStructure {
    fn default() -> Self {
        Self {
            delimiters: 0,
            indents: 0,
            unary: 0,
            expression_nodes: 0,
            logical_line_start: true,
            elif_chain_by_indent: vec![0],
        }
    }
}

impl PythonStructure {
    fn ignore_or_reset(&mut self, token: TokenKind) -> bool {
        if matches!(token, TokenKind::Comment | TokenKind::NonLogicalNewline) {
            return true;
        }
        if !matches!(token, TokenKind::Newline) {
            return false;
        }
        self.unary = 0;
        self.expression_nodes = 0;
        self.logical_line_start = true;
        true
    }

    fn observe_layout(&mut self, token: TokenKind) -> bool {
        match token {
            TokenKind::Lpar | TokenKind::Lsqb | TokenKind::Lbrace => {
                self.delimiters = self.delimiters.saturating_add(1);
            }
            TokenKind::Rpar | TokenKind::Rsqb | TokenKind::Rbrace => {
                self.delimiters = self.delimiters.saturating_sub(1);
            }
            TokenKind::Indent => {
                self.indents = self.indents.saturating_add(1);
                self.elif_chain_by_indent
                    .resize(self.indents.saturating_add(1), 0);
                return true;
            }
            TokenKind::Dedent => {
                self.indents = self.indents.saturating_sub(1);
                return true;
            }
            _ => {}
        }
        false
    }

    fn observe_line_start(&mut self, token: TokenKind) {
        if !self.logical_line_start {
            return;
        }
        let chain = &mut self.elif_chain_by_indent[self.indents];
        match token {
            TokenKind::If => *chain = 1,
            TokenKind::Elif => *chain = chain.saturating_add(1),
            TokenKind::Else => {}
            _ => *chain = 0,
        }
        self.logical_line_start = false;
    }

    fn observe_expression(&mut self, token: TokenKind) {
        if matches!(
            token,
            TokenKind::Plus
                | TokenKind::Minus
                | TokenKind::Star
                | TokenKind::Slash
                | TokenKind::Vbar
                | TokenKind::Amper
                | TokenKind::Less
                | TokenKind::Greater
                | TokenKind::Dot
                | TokenKind::Percent
                | TokenKind::EqEqual
                | TokenKind::NotEqual
                | TokenKind::LessEqual
                | TokenKind::GreaterEqual
                | TokenKind::CircumFlex
                | TokenKind::LeftShift
                | TokenKind::RightShift
                | TokenKind::DoubleStar
                | TokenKind::DoubleSlash
                | TokenKind::And
                | TokenKind::Or
                | TokenKind::In
                | TokenKind::Is
                | TokenKind::If
                | TokenKind::Else
                | TokenKind::Lambda
                | TokenKind::Lpar
                | TokenKind::Lsqb
        ) {
            self.expression_nodes = self.expression_nodes.saturating_add(1);
        } else if matches!(token, TokenKind::Comma | TokenKind::Semi) {
            self.expression_nodes = 0;
        }
    }

    fn observe_unary(&mut self, token: TokenKind) {
        if matches!(
            token,
            TokenKind::Not
                | TokenKind::Plus
                | TokenKind::Minus
                | TokenKind::Tilde
                | TokenKind::Await
        ) {
            self.unary = self.unary.saturating_add(1);
        } else {
            self.unary = 0;
        }
    }

    fn validate(&self) -> Result<(), AnalysisError> {
        if self.delimiters > MAX_STRUCTURAL_DEPTH
            || self.indents > MAX_STRUCTURAL_DEPTH
            || self.unary > MAX_STRUCTURAL_DEPTH
            || self.expression_nodes > MAX_STRUCTURAL_DEPTH
            || self.elif_chain_by_indent[self.indents] > MAX_STRUCTURAL_DEPTH
        {
            return Err(AnalysisError::Unsupported(format!(
                "source structural depth exceeds the {MAX_STRUCTURAL_DEPTH}-level safety limit"
            )));
        }
        Ok(())
    }
}

pub(super) struct DecodedSource<'a> {
    pub(super) text: &'a str,
    pub(super) byte_base: usize,
}

pub(super) fn decode_source(bytes: &[u8]) -> Result<DecodedSource<'_>, AnalysisError> {
    let (body, byte_base) = bytes
        .strip_prefix(UTF8_BOM)
        .map_or((bytes, 0), |without_bom| (without_bom, UTF8_BOM.len()));

    if let Some(encoding) = declared_encoding(body)
        && !is_utf8_encoding(&encoding)
    {
        return Err(AnalysisError::Unsupported(format!(
            "declared Python source encoding '{encoding}' is unsupported; UTF-8 is required"
        )));
    }

    let text = std::str::from_utf8(body)
        .map_err(|_| AnalysisError::Unsupported("Python source is not valid UTF-8".into()))?;
    Ok(DecodedSource { text, byte_base })
}

fn declared_encoding(bytes: &[u8]) -> Option<String> {
    let mut lines = bytes.splitn(3, |byte| *byte == b'\n');
    let first_with_ending = lines.next().unwrap_or_default();
    let first = first_with_ending
        .strip_suffix(b"\r")
        .unwrap_or(first_with_ending);
    if let Some(encoding) = encoding_cookie(first) {
        return Some(encoding);
    }
    if !comment_or_blank(first) {
        return None;
    }
    lines
        .next()
        .and_then(|line| encoding_cookie(line.strip_suffix(b"\r").unwrap_or(line)))
}

fn comment_or_blank(line: &[u8]) -> bool {
    line.iter()
        .copied()
        .find(|byte| !matches!(byte, b' ' | b'\t' | 0x0c))
        .is_none_or(|byte| byte == b'#')
}

fn encoding_cookie(line: &[u8]) -> Option<String> {
    let comment_start = line
        .iter()
        .position(|byte| !matches!(byte, b' ' | b'\t' | 0x0c))?;
    if line[comment_start] != b'#' {
        return None;
    }
    let comment = &line[comment_start + 1..];
    let lower = comment
        .iter()
        .map(u8::to_ascii_lowercase)
        .collect::<Vec<_>>();
    for (index, window) in lower.windows(b"coding".len()).enumerate() {
        if window != b"coding" {
            continue;
        }
        let mut cursor = index + b"coding".len();
        while lower.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        if !matches!(lower.get(cursor), Some(b':' | b'=')) {
            continue;
        }
        cursor += 1;
        while lower.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let start = cursor;
        while lower
            .get(cursor)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            cursor += 1;
        }
        if cursor > start {
            return Some(String::from_utf8_lossy(&comment[start..cursor]).into_owned());
        }
    }
    None
}

fn is_utf8_encoding(encoding: &str) -> bool {
    matches!(
        encoding
            .bytes()
            .filter(|byte| !matches!(byte, b'-' | b'_' | b'.'))
            .map(|byte| char::from(byte).to_ascii_lowercase())
            .collect::<String>()
            .as_str(),
        "utf" | "u8" | "utf8" | "utf8sig" | "cp65001"
    )
}
