pub mod helpers;
pub mod consumer;

pub trait Service {
    fn handle(&self) -> String;
}

pub struct Widget;

impl Widget {
    pub fn new() -> Self {
        Widget
    }
}

impl Service for Widget {
    fn handle(&self) -> String {
        helpers::assist()
    }
}
