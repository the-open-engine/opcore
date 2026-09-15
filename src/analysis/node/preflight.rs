use crate::{analysis::AnalysisError, cancel::CancelToken, limits::MAX_STRUCTURAL_DEPTH};

use super::check_cancel;

#[derive(Clone, Copy, Eq, PartialEq)]
enum ScanState {
    Code,
    SingleQuote,
    DoubleQuote,
    Template,
    LineComment,
    BlockComment,
}

pub(super) fn preflight_structure(source: &str, cancel: &CancelToken) -> Result<(), AnalysisError> {
    let bytes = source.as_bytes();
    let mut index = 0usize;
    let mut scanner = StructuralScanner::default();
    while index < bytes.len() {
        if index.is_multiple_of(1_024) {
            check_cancel(cancel)?;
        }
        let byte = bytes[index];
        let next = bytes.get(index.saturating_add(1)).copied();
        index = index.saturating_add(scanner.consume(byte, next)?);
        index = index.saturating_add(1);
    }
    Ok(())
}

struct StructuralScanner {
    state: ScanState,
    escaped: bool,
    depth: usize,
    unary: usize,
    template_expression_depths: Vec<usize>,
}

impl Default for StructuralScanner {
    fn default() -> Self {
        Self {
            state: ScanState::Code,
            escaped: false,
            depth: 0,
            unary: 0,
            template_expression_depths: Vec::new(),
        }
    }
}

impl StructuralScanner {
    fn consume(&mut self, byte: u8, next: Option<u8>) -> Result<usize, AnalysisError> {
        let skipped = match self.state {
            ScanState::SingleQuote | ScanState::DoubleQuote => self.consume_quote(byte),
            ScanState::Template => self.consume_template(byte, next)?,
            ScanState::LineComment => self.consume_line_comment(byte),
            ScanState::BlockComment => self.consume_block_comment(byte, next),
            ScanState::Code => self.consume_code(byte, next),
        };
        reject_excessive_structure(self.depth, self.unary)?;
        Ok(skipped)
    }

    fn consume_quote(&mut self, byte: u8) -> usize {
        if self.take_escape(byte) {
            return 0;
        }
        let closes = (self.state == ScanState::SingleQuote && byte == b'\'')
            || (self.state == ScanState::DoubleQuote && byte == b'"');
        if closes {
            self.leave_literal();
        }
        0
    }

    fn consume_template(&mut self, byte: u8, next: Option<u8>) -> Result<usize, AnalysisError> {
        if self.take_escape(byte) {
            return Ok(0);
        }
        if byte == b'`' {
            self.leave_literal();
            return Ok(0);
        }
        if byte != b'$' || next != Some(b'{') {
            return Ok(0);
        }
        self.depth = self.depth.saturating_add(1);
        self.template_expression_depths.push(self.depth);
        reject_excessive_structure(self.depth, self.unary)?;
        self.state = ScanState::Code;
        Ok(1)
    }

    fn consume_line_comment(&mut self, byte: u8) -> usize {
        if matches!(byte, b'\n' | b'\r') {
            self.state = ScanState::Code;
        }
        0
    }

    fn consume_block_comment(&mut self, byte: u8, next: Option<u8>) -> usize {
        if byte == b'*' && next == Some(b'/') {
            self.state = ScanState::Code;
            return 1;
        }
        0
    }

    fn consume_code(&mut self, byte: u8, next: Option<u8>) -> usize {
        if let Some(state) = comment_start(byte, next) {
            self.state = state;
            return 1;
        }
        if let Some(state) = literal_start(byte) {
            self.state = state;
            return 0;
        }
        self.consume_code_operator(byte);
        0
    }

    fn consume_code_operator(&mut self, byte: u8) {
        if matches!(byte, b'(' | b'[' | b'{') {
            self.depth = self.depth.saturating_add(1);
            self.unary = 0;
        } else if matches!(byte, b')' | b']') {
            self.depth = self.depth.saturating_sub(1);
            self.unary = 0;
        } else if byte == b'}' {
            self.close_brace();
        } else if matches!(byte, b'!' | b'~' | b'+' | b'-') {
            self.unary = self.unary.saturating_add(1);
        } else if !byte.is_ascii_whitespace() {
            self.unary = 0;
        }
    }

    fn close_brace(&mut self) {
        if self.template_expression_depths.last() == Some(&self.depth) {
            self.template_expression_depths.pop();
            self.state = ScanState::Template;
        }
        self.depth = self.depth.saturating_sub(1);
        self.unary = 0;
    }

    fn take_escape(&mut self, byte: u8) -> bool {
        if self.escaped {
            self.escaped = false;
            return true;
        }
        if byte == b'\\' {
            self.escaped = true;
            return true;
        }
        false
    }

    fn leave_literal(&mut self) {
        self.state = ScanState::Code;
        self.unary = 0;
    }
}

fn comment_start(byte: u8, next: Option<u8>) -> Option<ScanState> {
    match (byte, next) {
        (b'/', Some(b'/')) => Some(ScanState::LineComment),
        (b'/', Some(b'*')) => Some(ScanState::BlockComment),
        _ => None,
    }
}

const fn literal_start(byte: u8) -> Option<ScanState> {
    match byte {
        b'\'' => Some(ScanState::SingleQuote),
        b'"' => Some(ScanState::DoubleQuote),
        b'`' => Some(ScanState::Template),
        _ => None,
    }
}

fn reject_excessive_structure(depth: usize, unary: usize) -> Result<(), AnalysisError> {
    if depth > MAX_STRUCTURAL_DEPTH || unary > MAX_STRUCTURAL_DEPTH {
        return Err(AnalysisError::Unsupported(format!(
            "source structural depth exceeds the {MAX_STRUCTURAL_DEPTH}-level safety limit"
        )));
    }
    Ok(())
}
