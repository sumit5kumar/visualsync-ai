# GPU Zoom Experiment — Capability Record

## Official references

- FFmpeg’s filter reference describes `hwupload_cuda` as the CUDA hardware-frame upload filter and documents the available CUDA filter family: <https://ffmpeg.org/ffmpeg-filters.html>
- NVIDIA’s FFmpeg guide documents `scale_cuda` for GPU-resident resize, and states that avoiding system/video-memory transfers requires a compatible GPU-frame filter chain from decode or upload through NVENC: <https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/index.html>

## Installed Windows FFmpeg 8.1 finding

The installed build exposes `hwupload_cuda` and `scale_cuda`, but its filter audit reports no `crop_cuda`, `overlay_cuda`, or `scale_npp`. `scale_cuda` is a GPU accelerated resizer, not a time-varying centered crop/warp filter. This means a GPU zoom test must prove that a dynamic resize-and-crop equivalent can stay GPU-resident; otherwise the experiment must reject it rather than add CPU-to-GPU-to-CPU transfers to the stable renderer.
