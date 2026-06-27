use crate::helpers;
use crate::{Service, Widget};

pub fn run() -> String {
    let widget = Widget::new();
    helpers::assist();
    widget.handle()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run() {
        run();
    }
}
