// One axis of a resize, as FFmpeg's swscale makes it: lanczos (3 lobes) or its
// default bicubic (B 0, C 0.6), the kernel widened by the shrink when making
// smaller, pixel centres mapped (i + 0.5) * src / dst - 0.5, weights summing to
// one. An export's shape (`frame.rs`) runs it across, then down. The output
// index `i` along the axis is `local + offset` of the `virtual_len`-long
// resized line (a crop's offset is its first kept pixel); `origin` places the
// result in `dst` (a pad's border).

struct Params {
    axis: u32,
    kind: u32,
    src_len: f32,
    virtual_len: f32,
    offset: f32,
    origin: vec2<u32>,
    count: vec2<u32>,
    // Added to the output: the last pass's `frame.rs` DARKER, else 0.
    shift: vec4<f32>,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Params;

const PI: f32 = 3.14159265358979;

fn kernel(x: f32) -> f32 {
    let a = abs(x);
    if (p.kind == 0u) {
        if (a < 1e-6) {
            return 1.0;
        }
        if (a >= 3.0) {
            return 0.0;
        }
        let px = PI * a;
        return 3.0 * sin(px) * sin(px / 3.0) / (px * px);
    }
    if (a < 1.0) {
        return (8.4 * a * a * a - 14.4 * a * a + 6.0) / 6.0;
    }
    if (a < 2.0) {
        return (-3.6 * a * a * a + 18.0 * a * a - 28.8 * a + 14.4) / 6.0;
    }
    return 0.0;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.count.x || id.y >= p.count.y) {
        return;
    }
    let local = vec2<i32>(id.xy);
    let along = f32(local[p.axis]) + p.offset;
    let ratio = p.src_len / p.virtual_len;
    let center = (along + 0.5) * ratio - 0.5;
    let stretch = max(1.0, ratio);
    var lobes = 2.0;
    if (p.kind == 0u) {
        lobes = 3.0;
    }
    let reach = lobes * stretch;
    let first = i32(ceil(center - reach));
    let last = i32(floor(center + reach));
    let end = i32(p.src_len) - 1;
    var sum = vec4<f32>(0.0);
    var weights = 0.0;
    for (var k = first; k <= last; k++) {
        let w = kernel((f32(k) - center) / stretch);
        var at = local;
        at[p.axis] = clamp(k, 0, end);
        sum += w * textureLoad(src, at, 0);
        weights += w;
    }
    textureStore(dst, vec2<i32>(p.origin) + local, clamp(sum / weights + p.shift, vec4<f32>(0.0), vec4<f32>(1.0)));
}
