pub mod helpers;
mod user;

pub trait Service {
    fn handle(&self) -> usize;
}

pub struct Widget {
    name: String,
}

impl Widget {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
        }
    }

    pub fn greet(&self) -> String {
        format!("hello {}", self.name)
    }
}

pub enum Mode {
    Fast,
}

impl Service for Widget {
    fn handle(&self) -> usize {
        helpers::assist()
    }
}

pub type Alias = Widget;
pub const LIMIT: usize = 1;
pub static NAME: &str = "widget";

macro_rules! trace {
    () => {};
}

pub fn make_widget() -> Widget {
    Widget::new("opcore")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widget_smoke() {
        assert_eq!(make_widget().greet(), "hello opcore");
    }
}
