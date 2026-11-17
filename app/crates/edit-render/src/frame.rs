//! An export's shape on the GPU: the rendered picture resized to the output, or
//! fitted into another shape over black, cropped to fill it, or over a blurred
//! and darkened copy of itself, as FFmpeg's graph for them made it on the CPU
//! (`edit_engine::export::video_graph`, kept for the formats that still go
//! through FFmpeg). On the GPU the output goes on to the 4:2:0 readback and the
//! chunked hardware encoder like any other export: a minute of Vertical took
//! 42 s on mandalorian, 35 of them waiting on FFmpeg's two threads.

/// How the picture fills an output of another size or shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Fill {
    /// Resized to the output, which has its shape (`scale=w:h:flags=lanczos`).
    Stretch,
    /// Fitted inside, black around it.
    Black,
    /// Zoomed to cover it, the overflow cut off (centred).
    Crop,
    /// Fitted inside, over a copy zoomed to cover it, blurred (sigma 40) and darkened.
    Blur,
}

/// The output an export's frames are framed to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Framing {
    pub width: u32,
    pub height: u32,
    pub fill: Fill,
}

/// FFmpeg's `scale=w:h:force_original_aspect_ratio=decrease` (`cover` false)
/// or `increase` (true) of a `source` picture to `box`: the other side by
/// av_rescale (to nearest, halves away from zero), then the smaller or larger.
pub fn fitted(source: (u32, u32), bounds: (u32, u32), cover: bool) -> (u32, u32) {
    let rescale = |a: u32, b: u32, c: u32| -> u32 {
        ((u64::from(a) * u64::from(b) + u64::from(c) / 2) / u64::from(c.max(1))) as u32
    };
    let (sw, sh) = source;
    let (bw, bh) = bounds;
    let wide = rescale(bh, sw, sh);
    let tall = rescale(bw, sh, sw);
    if cover {
        (wide.max(bw), tall.max(bh))
    } else {
        (wide.min(bw), tall.min(bh))
    }
}

/// One axis's resize (`shaders/resample.wgsl`'s Params).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Resample {
    axis: u32,
    /// 0 lanczos, 1 bicubic.
    kind: u32,
    src_len: f32,
    virtual_len: f32,
    offset: f32,
    _pad: u32,
    origin: [u32; 2],
    count: [u32; 2],
    _tail: [u32; 2],
    shift: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct BlurParams {
    width: u32,
    height: u32,
    _pad: [u32; 2],
    nu: [f32; 4],
    ends: [f32; 4],
    post: [f32; 4],
    shift: [f32; 4],
}

/// What FFmpeg's graph for a shape added to the picture, in RGB: it went
/// through BT.601 4:2:0 (the blur's, the eq's and the overlay's format) and
/// back to BT.709, which swscale made darker than the conversion straight
/// from RGB (fitted on 576 colours, Nov 17: Y 1.55 levels under, the slopes
/// the same to 0.2%; its chroma's offsets, a quarter of a level, didn't show
/// in a whole export). Kept so a Vertical export looks as it did; Share and
/// the rest never had it.
const DARKER: [f32; 4] = {
    let y = -1.55 / 219.0;
    [y, y, y, 0.0]
};

/// FFmpeg's gblur parameters for `sigma` in one step: nu, the ends' weight,
/// and one axis's scale.
fn gblur(sigma: f64) -> (f32, f32, f64) {
    let lambda = sigma * sigma / 2.0;
    let nu = (1.0 + 2.0 * lambda - (1.0 + 4.0 * lambda).sqrt()) / (2.0 * lambda);
    (nu as f32, (1.0 / (1.0 - nu)) as f32, nu / lambda)
}

enum Pass {
    Compute {
        pipeline: wgpu::ComputePipeline,
        group: wgpu::BindGroup,
        groups: (u32, u32),
    },
}

pub(crate) struct Framer {
    pub(crate) framing: Framing,
    /// The framed picture, in half floats: the 4:2:0 readback converts it
    /// without rounding it to 8 bits first (FFmpeg's graph didn't either).
    _texture: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    /// It as RGBA8, for the readbacks that copy bytes (`pack`).
    pub(crate) bytes: wgpu::Texture,
    pack: Pass,
    passes: Vec<Pass>,
    /// Kept alive with the bind groups that use them.
    _keep: Vec<wgpu::Texture>,
    _buffers: Vec<wgpu::Buffer>,
}

const HALF: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const BYTE: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

fn storage_texture(
    device: &wgpu::Device,
    label: &str,
    size: (u32, u32),
    format: wgpu::TextureFormat,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: size.0.max(1),
            height: size.1.max(1),
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

struct Build<'a> {
    device: &'a wgpu::Device,
    resample: wgpu::ComputePipeline,
    passes: Vec<Pass>,
    keep: Vec<wgpu::Texture>,
    buffers: Vec<wgpu::Buffer>,
    /// Added to what the last passes write: DARKER for a Blur fill, whose
    /// graph alone went through BT.601 (a crop, a pad and a resize kept RGBA).
    shift: [f32; 4],
}

impl Build<'_> {
    fn uniform<T: bytemuck::Pod>(&mut self, value: &T) -> wgpu::Buffer {
        use wgpu::util::DeviceExt;
        let buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("edit framing params"),
                contents: bytemuck::bytes_of(value),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        self.buffers.push(buffer.clone());
        buffer
    }

    /// One axis of a resize from `src` (`src_len` along `axis`) into `dst`:
    /// `count` pixels at `origin`, the `virtual_len`-long resized line from
    /// `offset`; `last`, a pass writing the framed picture (`shift` added).
    #[allow(clippy::too_many_arguments)]
    fn resample(
        &mut self,
        src: &wgpu::TextureView,
        dst: &wgpu::TextureView,
        last: bool,
        axis: u32,
        bicubic: bool,
        src_len: u32,
        virtual_len: u32,
        offset: u32,
        origin: (u32, u32),
        count: (u32, u32),
    ) {
        let params = self.uniform(&Resample {
            axis,
            kind: u32::from(bicubic),
            src_len: src_len as f32,
            virtual_len: virtual_len as f32,
            offset: offset as f32,
            _pad: 0,
            origin: [origin.0, origin.1],
            count: [count.0, count.1],
            _tail: [0; 2],
            shift: if last { self.shift } else { [0.0; 4] },
        });
        let pipeline = self.resample.clone();
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("edit resample"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(src),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(dst),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: params.as_entire_binding(),
                },
            ],
        });
        self.passes.push(Pass::Compute {
            pipeline,
            group,
            groups: (count.0.div_ceil(8), count.1.div_ceil(8)),
        });
    }

    /// A resize of `src` (`source` px) to `size`, cropped from `crop` to
    /// `shown` px, into `dst` at `at`, across then down.
    #[allow(clippy::too_many_arguments)]
    fn resize(
        &mut self,
        src: &wgpu::TextureView,
        source: (u32, u32),
        size: (u32, u32),
        crop: (u32, u32),
        shown: (u32, u32),
        dst: &wgpu::TextureView,
        last: bool,
        at: (u32, u32),
        bicubic: bool,
    ) {
        let across = storage_texture(
            self.device,
            "edit framing across",
            (shown.0, source.1),
            HALF,
        );
        let across_view = across.create_view(&wgpu::TextureViewDescriptor::default());
        self.resample(
            src,
            &across_view,
            false,
            0,
            bicubic,
            source.0,
            size.0,
            crop.0,
            (0, 0),
            (shown.0, source.1),
        );
        self.resample(
            &across_view,
            dst,
            last,
            1,
            bicubic,
            source.1,
            size.1,
            crop.1,
            at,
            shown,
        );
        self.keep.push(across);
    }
}

impl Framer {
    /// The passes framing `source` (the renderer's output, `size` px) to `framing`.
    pub(crate) fn new(
        device: &wgpu::Device,
        source: &wgpu::TextureView,
        size: (u32, u32),
        framing: Framing,
    ) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("edit resample"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/resample.wgsl").into()),
        });
        let resample = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("edit resample"),
            layout: None,
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let output = (framing.width, framing.height);
        let texture = storage_texture(device, "edit framed", output, HALF);
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bytes = storage_texture(device, "edit framed bytes", output, BYTE);
        let pack = copy_pass(
            device,
            &view,
            &bytes.create_view(&wgpu::TextureViewDescriptor::default()),
            output,
        );
        let mut build = Build {
            device,
            resample,
            passes: Vec::new(),
            keep: Vec::new(),
            buffers: Vec::new(),
            shift: if framing.fill == Fill::Blur {
                DARKER
            } else {
                [0.0; 4]
            },
        };
        // Centred, rounded down; a Blur fill's graph worked in 4:2:0, whose
        // crop and overlay land on even pixels (a pad or crop of RGBA doesn't).
        let in_420 = framing.fill == Fill::Blur;
        let centred = |outer: u32, inner: u32| {
            let at = outer.saturating_sub(inner) / 2;
            if in_420 {
                at & !1
            } else {
                at
            }
        };
        match framing.fill {
            Fill::Stretch => {
                build.resize(
                    source,
                    size,
                    output,
                    (0, 0),
                    output,
                    &view,
                    true,
                    (0, 0),
                    false,
                );
            }
            Fill::Crop => {
                let cover = fitted(size, output, true);
                let crop = (centred(cover.0, output.0), centred(cover.1, output.1));
                build.resize(
                    source,
                    size,
                    cover,
                    crop,
                    output,
                    &view,
                    true,
                    (0, 0),
                    false,
                );
            }
            Fill::Black | Fill::Blur => {
                if framing.fill == Fill::Blur {
                    let cover = fitted(size, output, true);
                    let crop = (centred(cover.0, output.0), centred(cover.1, output.1));
                    let back = storage_texture(device, "edit framing back", output, HALF);
                    let back_view = back.create_view(&wgpu::TextureViewDescriptor::default());
                    build.resize(
                        source,
                        size,
                        cover,
                        crop,
                        output,
                        &back_view,
                        false,
                        (0, 0),
                        true,
                    );
                    blur(&mut build, &back_view, &view, output);
                    build.keep.push(back);
                } else {
                    clear(&mut build, &view, output);
                }
                let fit = fitted(size, output, false);
                let at = (centred(output.0, fit.0), centred(output.1, fit.1));
                build.resize(source, size, fit, (0, 0), fit, &view, true, at, false);
            }
        }
        let Build {
            passes,
            keep,
            buffers,
            ..
        } = build;
        Self {
            framing,
            _texture: texture,
            view,
            bytes,
            pack,
            passes,
            _keep: keep,
            _buffers: buffers,
        }
    }

    /// Frames the renderer's last output into `texture`.
    pub(crate) fn run(&self, device: &wgpu::Device, queue: &wgpu::Queue) {
        run(device, queue, &self.passes);
    }

    /// The framed picture copied into `bytes` (RGBA8), for a byte readback.
    pub(crate) fn pack(&self, device: &wgpu::Device, queue: &wgpu::Queue) -> &wgpu::Texture {
        run(device, queue, std::slice::from_ref(&self.pack));
        &self.bytes
    }
}

fn run(device: &wgpu::Device, queue: &wgpu::Queue, passes: &[Pass]) {
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("edit framing"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("edit framing"),
            timestamp_writes: None,
        });
        for step in passes {
            let Pass::Compute {
                pipeline,
                group,
                groups,
            } = step;
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(groups.0.max(1), groups.1.max(1), 1);
        }
    }
    queue.submit([encoder.finish()]);
}

/// The Blur fill's background from `back` (the covering copy) into `out`.
fn blur(build: &mut Build, back: &wgpu::TextureView, out: &wgpu::TextureView, size: (u32, u32)) {
    let device = build.device;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("edit fill blur"),
        source: wgpu::ShaderSource::Wgsl(include_str!("shaders/fill_blur.wgsl").into()),
    });
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("edit fill blur"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 3,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: HALF,
                    view_dimension: wgpu::TextureViewDimension::D2,
                },
                count: None,
            },
        ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("edit fill blur"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let (nu_y, ends_y, post_y) = gblur(40.0);
    let (nu_c, ends_c, post_c) = gblur(80.0);
    let params = build.uniform(&BlurParams {
        width: size.0,
        height: size.1,
        _pad: [0; 2],
        nu: [nu_y, nu_c, nu_c, 0.0],
        ends: [ends_y, ends_c, ends_c, 1.0],
        post: [
            (post_y * post_y) as f32,
            (post_c * post_c) as f32,
            (post_c * post_c) as f32,
            1.0,
        ],
        shift: build.shift,
    });
    let lines = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("edit fill blur lines"),
        size: u64::from(size.0) * u64::from(size.1) * 16,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("edit fill blur"),
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(back),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: lines.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: wgpu::BindingResource::TextureView(out),
            },
        ],
    });
    for (entry, groups) in [
        ("load", (size.0.div_ceil(8), size.1.div_ceil(8))),
        ("rows", (size.1.div_ceil(64), 1)),
        ("columns", (size.0.div_ceil(64), 1)),
        ("compose", (size.0.div_ceil(8), size.1.div_ceil(8))),
    ] {
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("edit fill blur"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some(entry),
            compilation_options: Default::default(),
            cache: None,
        });
        build.passes.push(Pass::Compute {
            pipeline,
            group: group.clone(),
            groups,
        });
    }
    build.buffers.push(lines);
}

/// Black over all of `out` (a Black fill's border).
fn clear(build: &mut Build, out: &wgpu::TextureView, size: (u32, u32)) {
    let device = build.device;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("edit framing clear"),
        source: wgpu::ShaderSource::Wgsl(
            "@group(0) @binding(0) var out: texture_storage_2d<rgba16float, write>;
             @compute @workgroup_size(8, 8)
             fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                 let size = textureDimensions(out);
                 if (id.x < size.x && id.y < size.y) {
                     textureStore(out, vec2<u32>(id.xy), vec4<f32>(0.0, 0.0, 0.0, 1.0));
                 }
             }"
            .into(),
        ),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("edit framing clear"),
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("edit framing clear"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::TextureView(out),
        }],
    });
    build.passes.push(Pass::Compute {
        pipeline,
        group,
        groups: (size.0.div_ceil(8), size.1.div_ceil(8)),
    });
}

/// A pass copying `from` into `to` (RGBA8), pixel for pixel.
fn copy_pass(
    device: &wgpu::Device,
    from: &wgpu::TextureView,
    to: &wgpu::TextureView,
    size: (u32, u32),
) -> Pass {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("edit framing pack"),
        source: wgpu::ShaderSource::Wgsl(
            "@group(0) @binding(0) var picture: texture_2d<f32>;
             @group(0) @binding(1) var to: texture_storage_2d<rgba8unorm, write>;
             @compute @workgroup_size(8, 8)
             fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                 let size = textureDimensions(to);
                 if (id.x < size.x && id.y < size.y) {
                     textureStore(to, vec2<u32>(id.xy), textureLoad(picture, vec2<u32>(id.xy), 0));
                 }
             }"
            .into(),
        ),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("edit framing pack"),
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("edit framing pack"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(from),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(to),
            },
        ],
    });
    Pass::Compute {
        pipeline,
        group,
        groups: (size.0.div_ceil(8), size.1.div_ceil(8)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_as_ffmpeg_does() {
        // 16:9 into 9:16 at 1080: FFmpeg's fg 1080x608 (607.5 to nearest, halves up), bg 3413x1920.
        assert_eq!(fitted((1920, 1080), (1080, 1920), false), (1080, 608));
        assert_eq!(fitted((1920, 1080), (1080, 1920), true), (3413, 1920));
        assert_eq!(fitted((1920, 1080), (1080, 1080), true), (1920, 1080));
        assert_eq!(fitted((1920, 1080), (1080, 1350), false), (1080, 608));
    }
}
