# Isolated GPU Zoom Experiment Result

## Scope and protection

The approved production renderer and the separate deterministic CPU candidate were not modified or invoked. The comparison uses the same Finance benchmark material previously measured for the GEQ and deterministic CPU experiments: segments 08 and 19, a total of 236 frames, with 5% AUTO centered zoom at 1920×1080 and 30 FPS.

## CPU baselines

| Zoom implementation | Zoom-frame time | CPU average | Output/stability result |
|---|---:|---:|---|
| Current GEQ reference | 54.688 s | 88–90% | Valid 1920×1080/30 FPS segment clips; no resets or duplicate consecutive frames. |
| Deterministic CPU candidate | 19.806 s | About 25% | Valid 1920×1080/30 FPS segment clips; no resets, crop reversals, or duplicate consecutive frames. |

## RTX 3050 / FFmpeg 8.1 capability result

The installed build successfully runs the GPU-resident control chain `hwupload_cuda → scale_cuda → h264_nvenc` at a static 1920×1080 size. This proves that the RTX 3050, CUDA upload, `scale_cuda`, and NVENC are functional.

However, a centered continuous zoom requires **time-varying geometry**: either per-frame scale dimensions or a per-frame crop-size change. The installed `scale_cuda` does not provide an `eval=frame` option. Its explicit per-frame evaluation probe failed with `Option not found`. A dynamic scale expression test did not produce valid frames. The build also has no `crop_cuda`, `overlay_cuda`, or `scale_npp` filter. The regular `crop` filter can accept a CUDA frame at a fixed size, but it does not supply the required GPU-native, frame-varying crop dimensions.

## Decision

No valid GPU-accelerated zoom candidate exists in this exact FFmpeg build that can preserve continuous centered IN/OUT zoom without CPU-to-GPU-to-CPU handoffs or a different GPU filter stack. Therefore there is no honest GPU zoom time, CPU/GPU/VRAM/FPS, SSIM, or stability benchmark to report for a candidate—zero valid dynamic-zoom frames were generated. Forcing a hybrid transfer path would violate the experiment requirement and is rejected.

The deterministic CPU candidate remains the only measured speed improvement and is still **not integrated** into production.

## Sources

- FFmpeg filter reference: <https://ffmpeg.org/ffmpeg-filters.html>
- NVIDIA FFmpeg CUDA workflow guide: <https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/index.html>
