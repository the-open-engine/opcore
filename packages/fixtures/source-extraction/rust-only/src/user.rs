use crate::helpers;
use crate::{Service, Widget};

pub fn run() -> usize {
    helpers::assist();
    let widget = Widget::new("runner");
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
