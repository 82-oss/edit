// A Blur fill's background (`frame.rs`) as FFmpeg's
// `gblur=sigma=40,eq=brightness=-0.08` makes it from a picture already in
// BT.601 TV-range YUV: Alvarez–Mazorra's recursive Gaussian in one step, a
// pass rightwards then leftwards along each row, then down and up each column,
// each line's ends weighted as if it went on; then FFmpeg's scale, clamp and
// truncation to 8 bits, and eq's brightness on Y (its 256 * (y / 255 - 0.08),
// truncated). The chroma is FFmpeg's quarter-size planes blurred at sigma 40,
// here the whole-size picture's at twice that. Back to RGB for the compositor.
// Blurred at a `step`th of the size (each line's loop is one invocation's, and
// an M1's GPU took most of a Vertical export's time running them whole) and
// read back up bilinearly: at sigma 40 nothing finer than that is left.

struct Params {
    // The blurred lines' size (the picture's over `step`, rounded up), and the picture's.
    width: u32,
    height: u32,
    full: vec2<u32>,
    // Per channel (Y, Cb, Cr, unused): the filter's nu, its ends' weight and the scale after both axes.
    nu: vec4<f32>,
    ends: vec4<f32>,
    post: vec4<f32>,
    // `frame.rs` DARKER.
    shift: vec4<f32>,
    step: u32,
};

@group(0) @binding(0) var picture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> lines: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> p: Params;
@group(0) @binding(3) var out: texture_storage_2d<rgba16float, write>;


@compute @workgroup_size(8, 8)
fn load(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.width || id.y >= p.height) {
        return;
    }
    var ycc = vec3<f32>(0.0);
    var count = 0.0;
    for (var dy = 0u; dy < p.step; dy++) {
        for (var dx = 0u; dx < p.step; dx++) {
            let at = min(id.xy * p.step + vec2<u32>(dx, dy), p.full - vec2<u32>(1u));
            let rgb = textureLoad(picture, at, 0).rgb;
            let l = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
            ycc += round(clamp(vec3<f32>(
                16.0 + 219.0 * l,
                128.0 + 224.0 * (rgb.b - l) / 1.772,
                128.0 + 224.0 * (rgb.r - l) / 1.402,
            ), vec3<f32>(0.0), vec3<f32>(255.0)));
            count += 1.0;
        }
    }
    lines[id.y * p.width + id.x] = vec4<f32>(ycc / count, 0.0);
}

@compute @workgroup_size(64)
fn rows(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.height) {
        return;
    }
    let start = id.x * p.width;
    var last = lines[start] * p.ends;
    lines[start] = last;
    for (var x = 1u; x < p.width; x++) {
        last = lines[start + x] + p.nu * last;
        lines[start + x] = last;
    }
    last = lines[start + p.width - 1u] * p.ends;
    lines[start + p.width - 1u] = last;
    for (var x = p.width - 1u; x > 0u; x--) {
        last = lines[start + x - 1u] + p.nu * last;
        lines[start + x - 1u] = last;
    }
}

@compute @workgroup_size(64)
fn columns(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.width) {
        return;
    }
    let w = p.width;
    var last = lines[id.x] * p.ends;
    lines[id.x] = last;
    for (var y = 1u; y < p.height; y++) {
        last = lines[y * w + id.x] + p.nu * last;
        lines[y * w + id.x] = last;
    }
    let bottom = (p.height - 1u) * w + id.x;
    last = lines[bottom] * p.ends;
    lines[bottom] = last;
    for (var y = p.height - 1u; y > 0u; y--) {
        last = lines[(y - 1u) * w + id.x] + p.nu * last;
        lines[(y - 1u) * w + id.x] = last;
    }
}

@compute @workgroup_size(8, 8)
fn compose(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.full.x || id.y >= p.full.y) {
        return;
    }
    // Bilinear between the four blurred values around this pixel's centre.
    let at = clamp((vec2<f32>(id.xy) + 0.5) / f32(p.step) - 0.5, vec2<f32>(0.0), vec2<f32>(f32(p.width - 1u), f32(p.height - 1u)));
    let low = vec2<u32>(floor(at));
    let high = min(low + vec2<u32>(1u), vec2<u32>(p.width - 1u, p.height - 1u));
    let t = at - floor(at);
    let top = mix(lines[low.y * p.width + low.x], lines[low.y * p.width + high.x], t.x);
    let bottom = mix(lines[high.y * p.width + low.x], lines[high.y * p.width + high.x], t.x);
    let blurred = floor(clamp(mix(top, bottom, t.y) * p.post, vec4<f32>(0.0), vec4<f32>(255.0)));
    let v = blurred.x / 255.0 - 0.08;
    var y = 0.0;
    if (v >= 1.0) {
        y = 255.0;
    } else if (v > 0.0) {
        y = floor(256.0 * v);
    }
    let l = (y - 16.0) / 219.0;
    let pb = (blurred.y - 128.0) / 224.0;
    let pr = (blurred.z - 128.0) / 224.0;
    let rgb = vec3<f32>(l + 1.402 * pr, l - 0.344136 * pb - 0.714136 * pr, l + 1.772 * pb);
    textureStore(out, vec2<u32>(id.xy), vec4<f32>(clamp(rgb + p.shift.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0));
}
