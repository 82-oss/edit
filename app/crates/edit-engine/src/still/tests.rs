#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::pixels::{self, Img, Kernel, Mask, Rgb};
use super::*;

fn dot(size: usize) -> Mask {
    let mut out = Img::filled(size, size, false);
    out.set(size / 2, size / 2, true);
    out
}

fn rows_of(mask: &Mask) -> Vec<String> {
    (0..mask.h)
        .map(|y| {
            (0..mask.w)
                .map(|x| if mask.at(x, y) { '#' } else { '.' })
                .collect()
        })
        .collect()
}

#[test]
fn an_ellipse_is_opencvs() {
    assert_eq!(
        rows_of(&pixels::dilate(&dot(5), &Kernel::ellipse(5, 5))),
        ["..#..", "#####", "#####", "#####", "..#.."]
    );
    // A 2×2 kernel reads one before (OpenCV's anchor at 1, 1) when eroding and dilating alike: an opening moves a block
    // one pixel down and right, as cv2's does.
    let mut block = Img::filled(6, 6, false);
    block.fill(2, 2, 4, 4);
    let mut moved = Img::filled(6, 6, false);
    moved.fill(3, 3, 5, 5);
    let two = Kernel::rect(2, 2);
    assert_eq!(pixels::dilate(&pixels::erode(&block, &two), &two), moved);
}

#[test]
fn parts_are_numbered_in_opencvs_order() {
    // B's first pixel comes first row by row, but A's 2×2 block comes first two rows at a time, as OpenCV scans.
    let mut mask = Img::filled(8, 4, false);
    mask.set(5, 0, true); // B
    mask.set(0, 1, true); // A
    mask.set(0, 2, true);
    let (count, labels, sizes) = pixels::parts(&mask);
    assert_eq!(count, 3);
    assert_eq!(labels.at(0, 1), 1);
    assert_eq!(labels.at(5, 0), 2);
    assert_eq!(sizes[1], (1, 2));
}

#[test]
fn telea_fills_as_opencv_does() {
    let mut img: Rgb = Img::filled(12, 10, [0; 3]);
    for y in 0..10 {
        for x in 0..12 {
            img.set(
                x,
                y,
                [
                    (20 * x % 256) as u8,
                    (25 * y % 256) as u8,
                    (7 * x * y % 256) as u8,
                ],
            );
        }
    }
    let before = img.clone();
    let mut holes = Img::filled(12, 10, false);
    holes.fill(5, 4, 8, 7);
    holes.set(0, 0, true);
    pixels::telea(&mut img, &holes, 3.0);
    // cv2.inpaint(…, 3, INPAINT_TELEA) gave these (OpenCV 5.1).
    assert_eq!(img.at(5, 4), [88, 85, 104]);
    assert_eq!(img.at(6, 5), [119, 115, 117]);
    assert_eq!(img.at(7, 6), [139, 140, 118]);
    assert_eq!(img.at(7, 4), [141, 85, 138]);
    assert_eq!(img.at(0, 0), [17, 21, 5]);
    for k in 0..img.v.len() {
        if !holes.v[k] {
            assert_eq!(img.v[k], before.v[k]);
        }
    }
}

#[test]
fn numpy_and_the_band_agree_with_python() {
    assert!(
        (pixels::percentile(&[3.0, 7.0, 1.0, 9.0, 4.0, 4.0, 10.0, 12.0, 2.0], 2.0) - 1.16).abs()
            < 1e-12
    );
    assert!(
        (pixels::percentile(&[3.0, 7.0, 1.0, 9.0, 4.0, 4.0, 10.0, 12.0, 2.0], 98.0) - 11.68).abs()
            < 1e-12
    );
    // minimax_worker.band_of's answers.
    let band = |masks: Vec<Vec<[f64; 4]>>, _w: usize, h| band_of(&masks, h);
    assert_eq!(
        band(
            vec![
                vec![[100.0, 600.0, 800.0, 660.0]],
                vec![],
                vec![[90.0, 610.0, 810.0, 650.0]]
            ],
            1280,
            720
        ),
        Some((566, 694))
    );
    assert_eq!(
        band(vec![vec![[100.0, 1000.0, 800.0, 1070.0]]], 1920, 1080),
        Some((920, 1080))
    );
    assert_eq!(
        band(vec![vec![[100.0, 300.0, 800.0, 500.0]]], 1920, 1080),
        Some((190, 610))
    );
    assert_eq!(band(vec![vec![]], 1920, 1080), None);
}

/// A room of grain, a caption's word (white strokes on a dark shadow) and a white pad far enough from it, at 1080 lines.
fn a_captioned_frame() -> Rgb {
    let (w, h) = (900, 200);
    let mut frame = Img::filled(w, h, [0u8; 3]);
    let mut seed = 7u32;
    for px in &mut frame.v {
        for c in px.iter_mut() {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *c = 90 + (seed >> 24) as u8 % 50;
        }
    }
    let mut paint = |x0: usize, y0: usize, x1: usize, y1: usize, value: u8| {
        for y in y0..y1 {
            for x in x0..x1 {
                frame.set(x, y, [value; 3]);
            }
        }
    };
    paint(96, 76, 304, 124, 20); // the word's shadow
    for stroke in 0..12 {
        let x = 100 + stroke * 17;
        paint(x, 80, x + 4, 120, 245);
    }
    paint(640, 70, 720, 130, 240); // a white pad: wide, no shadow
    frame
}

#[test]
fn letters_take_the_words_and_leave_a_pad() {
    let frame = a_captioned_frame();
    let (mask, cover) = letters(&frame, &[[80.0, 70.0, 760.0, 130.0]], 0.0, 1.0);
    assert!(mask.at(102, 100) && mask.at(200, 90), "the strokes");
    assert!(mask.at(98, 78), "their shadow");
    assert!(!mask.at(680, 100), "the pad is the room's");
    assert!(cover.at(102, 100) && !cover.at(680, 100));
    // An empty box (a fade): nothing masked, but it isn't read from either.
    let room = Img::filled(900, 200, [120u8; 3]);
    let (mask, cover) = letters(&room, &[[80.0, 70.0, 760.0, 130.0]], 0.0, 1.0);
    assert!(!mask.any());
    assert!(cover.at(400, 100));
}

#[test]
fn a_passer_by_is_outvoted_and_an_unseen_spot_is_blind() {
    let (w, rows) = (60, 40);
    let room = [100u8, 110, 120];
    let mut frames: VecDeque<Rgb> = (0..30).map(|_| Img::filled(w, rows, room)).collect();
    // Someone passes the spot in the frame nearest after this one.
    frames[13] = Img::filled(w, rows, [250, 20, 20]);
    let mut own: VecDeque<Mask> = (0..30).map(|_| Img::filled(w, rows, false)).collect();
    // A spot no other frame shows (each has a caption there).
    for one in own.iter_mut() {
        one.fill(40, 10, 50, 20);
    }
    let window = Window { frames, own };
    let mut mask = Img::filled(w, rows, false);
    mask.fill(20, 15, 30, 25);
    mask.fill(42, 12, 48, 18);
    let other = Img::filled(w, rows, [10u8, 10, 10]);
    let unseen = Img::filled(w, rows, false);
    let real = Img::filled(w, rows, [30u8, 30, 30]);
    let pictures = Pictures {
        plate: &other,
        nearby: &other,
        seen: &unseen,
        real: &real,
        trust: &unseen,
        certain: &unseen,
    };
    let mut blind = [0usize; 2];
    let out = filled(
        &window.frames[10],
        &pictures,
        &mask,
        1.0,
        &window,
        10,
        &mut blind,
    );
    assert_eq!(out.at(25, 20), room, "the room, voted on");
    assert_eq!(
        out.at(45, 15),
        [30, 30, 30],
        "never shown clear: the clear frame's"
    );
    assert_eq!(blind, [36, 136]);
    assert_eq!(out.at(5, 5), [10, 10, 10], "outside the mask: the plate");
}

fn a_job(dir: &Path, masks: Vec<Vec<Vec<f64>>>, beneath: Vec<Value>, marks: Value) -> Job {
    let found = dir.join("found.json");
    std::fs::write(&found, json!({"version": 1, "width": 1280, "height": 720, "fps": 30, "covered": [[0, 60]], "masks": marks}).to_string()).unwrap();
    Job {
        input: dir.join("none.mp4").to_string_lossy().into_owned(),
        input_args: Vec::new(),
        from: 10.0,
        fps: 30.0,
        width: 1280.0,
        height: 720.0,
        matrix: "bt709".to_owned(),
        masks,
        out: dir.join("strip.mp4").to_string_lossy().into_owned(),
        beneath,
        found: found.to_string_lossy().into_owned(),
        plates: dir.join("plates").to_string_lossy().into_owned(),
        key: "youtube:test".to_owned(),
        also: Vec::new(),
    }
}

#[test]
fn stretches_it_wont_clean_say_why_before_reading_any_footage() {
    let dir = std::env::temp_dir().join(format!("edit-still-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let captions: Vec<Value> = (0..10)
        .map(|i| json!([i * 30, i * 30 + 25, 300, 600, 900, 650, "subtitle"]))
        .collect();
    let words = vec![vec![300.0, 600.0, 900.0, 650.0]];
    let never = || false;
    // A watermark already taken out under it: the model.
    let job = a_job(
        &dir,
        vec![words.clone()],
        vec![json!({"file": "x"})],
        Value::Array(captions.clone()),
    );
    assert_eq!(
        clean(&job, &never).unwrap()["why"],
        "a cleaned watermark under it"
    );
    // A box far from where the file's captions come up, with no label's blur over it: the model.
    let job = a_job(
        &dir,
        vec![words.clone(), vec![vec![100.0, 50.0, 300.0, 90.0]]],
        Vec::new(),
        Value::Array(captions.clone()),
    );
    assert_eq!(
        clean(&job, &never).unwrap()["why"],
        "a caption away from the others"
    );
    // The same box under a label's blur at that frame is left alone; with no words left, nothing to clean.
    let mut marks = captions.clone();
    marks.push(json!([300, 302, 90, 40, 320, 100, "label"]));
    let job = a_job(
        &dir,
        vec![vec![], vec![vec![100.0, 50.0, 300.0, 90.0]]],
        Vec::new(),
        Value::Array(marks),
    );
    assert_eq!(
        clean(&job, &never).unwrap(),
        json!({"still": true, "box": null, "inferred": 0})
    );
    // Stopped: an error, and nothing written.
    let job = a_job(&dir, vec![words], Vec::new(), Value::Array(captions));
    assert_eq!(
        clean(&job, &|| true).unwrap_err(),
        "the still clean was stopped"
    );
    assert!(!dir.join("strip.mp4").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_kept_plate_reads_back_and_another_version_does_not() {
    let dir = std::env::temp_dir().join(format!("edit-still-plate-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("p.plate");
    let one = Plated {
        small: Img::filled(SMALL.0, SMALL.1, [1, 2, 3]),
        plate: Img::filled(8, 3, [4, 5, 6]),
        sure: Img::filled(8, 3, 200),
        real: Img::filled(8, 3, [7, 8, 9]),
    };
    save_plates(&path, (10, 13), 8, std::slice::from_ref(&one)).unwrap();
    assert_eq!(load_plates(&path, 8), Some(((10, 13), vec![one])));
    assert_eq!(load_plates(&path, 9), None, "another width");
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[0] = 9;
    std::fs::write(&path, bytes).unwrap();
    assert_eq!(load_plates(&path, 8), None, "another version");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn luma_is_opencvs_to_the_level() {
    // cv2.cvtColor(RGB2GRAY) on OpenCV 4.x: 15-bit coefficients. A saturated blue is where 14 bits came out a level high.
    assert_eq!(pixels::luma([0, 0, 250]), 28);
    assert_eq!(pixels::luma([250, 0, 0]), 75);
    assert_eq!(pixels::luma([0, 250, 0]), 147);
    assert_eq!(pixels::luma([128, 128, 128]), 128);
}

#[test]
fn a_flat_frame_is_no_black_and_white_room() {
    let free = Img::filled(200, 100, true);
    assert!(
        !is_gray(&Img::filled(200, 100, [250, 250, 250]), &free),
        "a white flash"
    );
    let room = Img {
        w: 200,
        h: 100,
        v: (0..20_000)
            .map(|k| {
                let v = (k * 37 % 200) as u8;
                [v, v, v]
            })
            .collect(),
    };
    assert!(is_gray(&room, &free));
}

#[test]
fn keys_that_clean_the_same_keep_their_own_plates() {
    let dir = std::env::temp_dir().join(format!("edit-still-key-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut one = a_job(&dir, Vec::new(), Vec::new(), Value::Array(Vec::new()));
    let mut other = one.clone();
    one.key = "youtube:aBcDeFgHi_A".to_owned();
    other.key = "youtube:aBcDeFgHi-A".to_owned();
    assert_ne!(plate_path(&one), plate_path(&other));
    let _ = std::fs::remove_dir_all(&dir);
}
