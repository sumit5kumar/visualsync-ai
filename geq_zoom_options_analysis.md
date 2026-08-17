# GEQ Center-Zoom Technical Options Analysis

## Scope and baseline

This analysis evaluates only the stable continuous GEQ center-zoom stage. The accepted zoom implementation, direct-opacity crossfade, timeline, image matching, narration synchronization, and 1920×1080 / 30 FPS output contract are unchanged.

The full Finance CPU baseline completed in **751.980 seconds** for **2,024 output frames** over **67.451 seconds**. Continuous GEQ zoom-frame generation required **467.933 seconds (62%)**, direct crossfade composition required **250.714 seconds (33%)**, and the final H.264/audio mux required **33.149 seconds (4%)**.

The current zoom filter first normalizes every image to a 2,112×1,188 canvas, converts it to YUV444P, evaluates three bilinear GEQ coordinate expressions per frame, and then performs a Lanczos scale to 1,920×1,080. Across 2,024 frames, this amounts to approximately **5.08 billion 2,112×1,188 GEQ frame pixels**, or **15.23 billion per-plane GEQ expression evaluations**, before the final output rescale. That per-pixel bilinear sampling is the direct reason this stage dominates runtime.

## Measured threading evidence

The connected laptop has **12 logical processors**. The exact current GEQ filter was measured on a Finance image for 30 frames without changing the renderer.

| GEQ filter-thread setting | 30-frame elapsed time | Interpretation |
|---|---:|---|
| Explicit `1` | 33.086 s | Single-thread GEQ is substantially slower. |
| Explicit `8` | 5.789 s | Slice threading is effective. |
| Current FFmpeg default | 5.286 s | The current default is already faster than the explicit eight-thread trial. |

FFmpeg reports that `geq` supports slice threading. Therefore, adding a fixed `-filter_threads 8` setting is **not recommended**: it was slower than the current default in this environment. The current worker is already receiving the useful automatic thread parallelism from FFmpeg.

## CUDA feasibility in this exact installation

The installed FFmpeg build exposes `cuda`, `h264_nvenc`, `hwupload_cuda`, and `scale_cuda`; it does **not** expose `scale_npp` or a CUDA overlay/compositor. An isolated standard-YUV clip successfully ran `hwupload_cuda → scale_cuda → h264_nvenc` while remaining in GPU memory. However, the Finance JPEG source did not enter that GPU chain directly without a pixel-format conversion boundary.

`scale_cuda` is a GPU **resizer**, not a GPU equivalent of GEQ's per-pixel, time-varying source-coordinate transform. NVIDIA documents that GPU scaling produces its performance benefit when frames remain in GPU memory through scaling and NVENC; it also documents explicit upload for software-originated frames.[2] The current renderer must then return to CPU memory for the established `System.Drawing` alpha compositor. Replacing only the initial or final scale with CUDA would therefore create CPU → GPU → CPU transfers, retain all GEQ computation on CPU, and risk making the pipeline slower.

## Technical options

| Option | Visual-equivalence confidence | Realistic speed potential | Main trade-off | Recommendation |
|---|---|---|---|---|
| Keep the current GEQ filter with FFmpeg automatic slice threading | Exact current appearance | No further material gain shown by threading test | No speed improvement | **Keep as baseline** |
| Force a fixed `-filter_threads 8` value | Exact pixels expected, but must still be checked | Negative in the 30-frame test | Explicit eight threads were slower than current automatic behavior | **Reject** |
| Replace GEQ with `zoompan`, animated crop, or staged scale/crop | Low; prior variants created shake or drift | Potentially faster | Integer crop/rounding and changed temporal sampling threaten the accepted editor-style motion | **Reject without a separate visual experiment** |
| Use `scale_cuda` around the existing GEQ stage | High only if GEQ remains unchanged | Low to none | GEQ remains CPU-bound; mandatory upload/download boundaries add overhead; current compositor is CPU-only | **Do not implement** |
| Rebuild zoom as a custom CUDA filter or shader | Unknown until exact-pixel tests | Potentially high | This FFmpeg build has no drop-in GPU GEQ transform; requires custom native GPU code, new build tooling, and exact visual regression testing | **Research-only, high risk** |
| Rebuild zoom in a separate optimized CPU raster/SIMD implementation | Unknown until visual tests | Potentially moderate to high | A new resampler risks reintroducing jitter, color changes, or frame instability | **Only after explicit approval and isolated comparison renders** |

## Potential whole-render improvement

Because GEQ accounts for 62% of the measured baseline, Amdahl-style limits are clear.

| Hypothetical GEQ acceleration | Estimated total render time | Whole-render speedup |
|---|---:|---:|
| 2× faster GEQ | 518.013 s | 1.451× |
| 4× faster GEQ | 401.030 s | 1.875× |
| Instant GEQ (unachievable ceiling) | approximately 284 s | 2.647× |

These are mathematical ceilings based on the measured Finance profile, not promised benchmark results.

## Recommendation

Do **not** alter the renderer now. The evidence does not support a drop-in CUDA replacement: the available CUDA filter is only scaling, while the bottleneck is the CPU GEQ coordinate warp and the next stage is a CPU-only compositor. The safest future experiment is an **isolated, separately named candidate renderer** that attempts a deterministic CPU-optimized zoom implementation, then compares frame hashes, fixed 30 FPS, audio duration, and user-visible stability against the accepted GEQ output. A custom CUDA filter should be considered only if that isolated CPU candidate cannot produce a meaningful gain.

## References

[1] [FFmpeg Filters Documentation — GEQ, threading, and hardware-frame filters](https://ffmpeg.org/ffmpeg-filters.html)

[2] [NVIDIA Video Codec SDK — Using FFmpeg with NVIDIA GPU Hardware Acceleration](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/ffmpeg-with-nvidia-gpu/index.html)
