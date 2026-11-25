//! One stretch through the caption clean, from a job file (the still clean's job), for trying it on footage:
//!   cargo run --release -p edit-engine --example caption_clean -- <job.json> <lama.onnx> [key-moving key-still agree]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(job), Some(model)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: caption_clean <job.json> <lama.onnx> [key-moving key-still agree]");
        std::process::exit(2);
    };
    let job = match std::fs::read_to_string(job)
        .map_err(|e| e.to_string())
        .and_then(|text| {
            serde_json::from_str::<edit_engine::still::Job>(&text).map_err(|e| e.to_string())
        }) {
        Ok(job) => job,
        Err(error) => {
            eprintln!("the job: {error}");
            std::process::exit(2);
        }
    };
    let mut tuning = edit_engine::caption::Tuning::default();
    if let (Some(a), Some(b), Some(c)) = (args.get(3), args.get(4), args.get(5)) {
        tuning.key_moving = a.parse().unwrap_or(tuning.key_moving);
        tuning.key_still = b.parse().unwrap_or(tuning.key_still);
        tuning.agree = c.parse().unwrap_or(tuning.agree);
    }
    let started = std::time::Instant::now();
    match edit_engine::caption::clean_with(&job, std::path::Path::new(model), tuning, &|| false) {
        Ok(answer) => println!(
            "{answer}\n{:.1} s for {} frames ({:.0} ms a frame)",
            started.elapsed().as_secs_f64(),
            job.masks.len(),
            started.elapsed().as_secs_f64() * 1000.0 / job.masks.len().max(1) as f64
        ),
        Err(error) => {
            eprintln!("failed: {error}");
            std::process::exit(1);
        }
    }
}
