mod helpers;

use crate::helpers::helper_value;
use serde::Serialize;

macro_rules! make_label {
    () => {
        "widget"
    };
}

pub type WidgetId = u64;
pub const DEFAULT_ID: WidgetId = 7;
pub static DEFAULT_NAME: &str = "widget";

#[derive(Serialize)]
pub struct Widget {
    id: WidgetId,
}

pub enum WidgetState {
    Ready,
    Waiting,
}

pub trait Greeter {
    fn greet(&self) -> String;
}

impl Widget {
    pub fn new(id: WidgetId) -> Self {
        Self { id }
    }

    pub fn label(&self) -> &'static str {
        make_label!()
    }
}

impl Greeter for Widget {
    fn greet(&self) -> String {
        let value = helper_value();
        format!("{}-{value}", self.label())
    }
}

pub fn build_widget() -> Widget {
    Widget::new(DEFAULT_ID)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_widget() {
        let widget = build_widget();
        assert_eq!(widget.greet(), "widget-11");
    }
}
