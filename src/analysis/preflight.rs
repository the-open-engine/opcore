use crate::{
    analysis::AnalysisError,
    cancel::{CANCELLATION_POLL_INTERVAL, CancelToken},
};

pub(crate) fn bounded_structure(
    source: &[u8],
    language: &str,
    max_depth: usize,
    cancel: &CancelToken,
) -> Result<(), AnalysisError> {
    check_cancellation(source, cancel)?;
    for (kind, depth) in [
        ("delimiter", delimiter_depth(source)),
        ("indentation", indentation_depth(source)),
        ("unary expression", unary_depth(source)),
        ("binary expression", binary_depth(source)),
        ("postfix expression", postfix_depth(source)),
    ] {
        reject_depth(language, kind, depth, max_depth)?;
    }
    Ok(())
}

fn check_cancellation(source: &[u8], cancel: &CancelToken) -> Result<(), AnalysisError> {
    for _ in source.chunks(CANCELLATION_POLL_INTERVAL) {
        if cancel.is_cancelled() {
            return Err(AnalysisError::Cancelled);
        }
    }
    Ok(())
}

fn delimiter_depth(source: &[u8]) -> usize {
    let mut current = 0usize;
    let mut maximum = 0usize;
    for line in source.split(|byte| matches!(byte, b'\r' | b'\n')) {
        if !comment_only(line) {
            for byte in line {
                if matches!(byte, b'(' | b'[' | b'{') {
                    current = current.saturating_add(1);
                    maximum = maximum.max(current);
                } else if matches!(byte, b')' | b']' | b'}') {
                    current = current.saturating_sub(1);
                }
            }
        }
    }
    maximum
}

fn indentation_depth(source: &[u8]) -> usize {
    source
        .split(|byte| matches!(byte, b'\r' | b'\n'))
        .filter(|line| !comment_only(line))
        .map(|line| {
            line.iter()
                .take_while(|byte| matches!(byte, b' ' | b'\t'))
                .map(|byte| if *byte == b'\t' { 4 } else { 1 })
                .sum::<usize>()
                / 4
        })
        .max()
        .unwrap_or(0)
}

fn unary_depth(source: &[u8]) -> usize {
    source
        .split(|byte| matches!(byte, b'\r' | b'\n'))
        .filter(|line| !comment_only(line))
        .map(|line| contiguous_operator_depth(line, |byte| matches!(byte, b'!' | b'~' | b'-')))
        .max()
        .unwrap_or(0)
}

fn binary_depth(source: &[u8]) -> usize {
    expression_chain_depth(source, |byte| {
        matches!(
            byte,
            b'+' | b'-' | b'*' | b'/' | b'%' | b'<' | b'>' | b'&' | b'|' | b'?'
        )
    })
}

fn postfix_depth(source: &[u8]) -> usize {
    expression_chain_depth(source, |byte| matches!(byte, b'.' | b'['))
}

fn expression_chain_depth(source: &[u8], is_operator: fn(u8) -> bool) -> usize {
    source
        .split(|byte| matches!(byte, b'\r' | b'\n'))
        .filter(|line| !comment_only(line))
        .map(|line| segment_chain_depth(line, is_operator))
        .max()
        .unwrap_or(0)
}

fn segment_chain_depth(source: &[u8], is_operator: fn(u8) -> bool) -> usize {
    let mut current = 0usize;
    let mut maximum = 0usize;
    for byte in source.iter().copied() {
        if is_operator(byte) {
            current = current.saturating_add(1);
            maximum = maximum.max(current);
        } else if matches!(byte, b';' | b',' | b'{' | b'}') {
            current = 0;
        }
    }
    maximum
}

fn contiguous_operator_depth(source: &[u8], is_operator: fn(u8) -> bool) -> usize {
    let mut current = 0usize;
    let mut maximum = 0usize;
    for byte in source.iter().copied() {
        if is_operator(byte) {
            current = current.saturating_add(1);
            maximum = maximum.max(current);
        } else {
            current = 0;
        }
    }
    maximum
}

fn comment_only(line: &[u8]) -> bool {
    let line = line
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .map_or(&[][..], |start| &line[start..]);
    line.starts_with(b"#") || line.starts_with(b"//")
}

fn reject_depth(
    language: &str,
    kind: &str,
    depth: usize,
    max_depth: usize,
) -> Result<(), AnalysisError> {
    if depth > max_depth {
        Err(AnalysisError::Unsupported(format!(
            "{language} {kind} depth exceeds the {max_depth}-level parser safety limit"
        )))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comment_separators_do_not_look_like_expression_depth() {
        let source = format!("# {}\necho ok\n", "-".repeat(1_000));
        assert!(bounded_structure(source.as_bytes(), "Shell", 64, &CancelToken::new()).is_ok());
    }

    #[test]
    fn contiguous_unary_depth_remains_bounded() {
        let source = format!("value = {}true\n", "!".repeat(65));
        assert!(matches!(
            bounded_structure(source.as_bytes(), "HCL", 64, &CancelToken::new()),
            Err(AnalysisError::Unsupported(message)) if message.contains("unary expression")
        ));
    }
}
