from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query, Body
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window
from io import BytesIO
from pathlib import Path
from typing import Optional
import math
import json
import os
import urllib.error
import urllib.request
from collections import OrderedDict
import threading

TILE_SIZE = 512
PREVIEW_MAX_SIZE = 768
THUMBNAIL_MAX_SIZE = 180
JPEG_QUALITY = 82

app = FastAPI(title="ISRO Remote Sensing Image Viewer API")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https://.*\.app\.github\.dev|http://localhost:\d+|http://127\.0\.0\.1:\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent.parent
STORAGE_DIR = BASE_DIR / "storage"
STORAGE_DIR.mkdir(exist_ok=True)

MAX_STRETCH_CACHE = 30
auto_stretch_cache: OrderedDict = OrderedDict()
cache_lock = threading.Lock()
RASTER_READ_LIMIT = 6
raster_read_semaphore = threading.BoundedSemaphore(RASTER_READ_LIMIT)
stretch_compute_lock = threading.Lock()
UPLOAD_CHUNK_SIZE = 2 * 1024 * 1024
upload_chunks = {}
upload_lock = threading.Lock()


def _cache_set(cache: OrderedDict, key, value, max_items: int):
    with cache_lock:
        if key in cache:
            cache.move_to_end(key)
        cache[key] = value
        while len(cache) > max_items:
            cache.popitem(last=False)


def _cache_get(cache: OrderedDict, key):
    with cache_lock:
        if key in cache:
            cache.move_to_end(key)
            return cache[key]
    return None


def clear_analysis_cache():
    with cache_lock:
        auto_stretch_cache.clear()


def cleanup_old_files(max_files: int = 15, max_total_gb: float = 10.0):
    files = [p for p in STORAGE_DIR.rglob("*") if p.is_file() and p.suffix.lower() in {".tif", ".tiff"}]
    if not files:
        return
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for p in files[max_files:]:
        try:
            p.unlink(missing_ok=True)
        except Exception:
            pass
    files = [p for p in STORAGE_DIR.rglob("*") if p.is_file() and p.suffix.lower() in {".tif", ".tiff"}]
    files.sort(key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    max_bytes = int(max_total_gb * 1024 ** 3)
    while total > max_bytes and files:
        oldest = files.pop(0)
        try:
            size = oldest.stat().st_size
            oldest.unlink(missing_ok=True)
            total -= size
        except Exception:
            pass


def get_file_path(filename: str) -> Path:
    if not filename:
        raise HTTPException(status_code=400, detail="Filename is required")
    filename = filename.replace("+", " ").strip().lstrip("/")
    storage_root = STORAGE_DIR.resolve()
    storage_path = (STORAGE_DIR / filename).resolve()
    if storage_root in storage_path.parents and storage_path.exists():
        return storage_path
    clean_name = Path(filename).name
    root_path = (BASE_DIR / clean_name).resolve()
    if (
        root_path.parent == BASE_DIR
        and root_path.suffix.lower() in {".tif", ".tiff"}
        and root_path.exists()
        and root_path.is_file()
    ):
        return root_path
    return storage_path


def validate_file_exists(filename: str) -> Path:
    file_path = get_file_path(filename)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")
    return file_path


def preview_dimensions(width: int, height: int, max_size: int):
    scale = min(1.0, max_size / max(width, 1), max_size / max(height, 1))
    return max(1, int(width * scale)), max(1, int(height * scale))


def read_preview_band(src, band=1, max_size=PREVIEW_MAX_SIZE):
    out_w, out_h = preview_dimensions(src.width, src.height, max_size)
    return src.read(band, out_shape=(out_h, out_w), resampling=Resampling.average, masked=True)


def brighten_preview(data, nodata=None, low_percentile=2, high_percentile=98):
    original_mask = np.ma.getmaskarray(data)
    arr = np.asarray(np.ma.filled(data, np.nan), dtype=np.float32)
    valid_mask = np.isfinite(arr) & ~original_mask
    if nodata is not None:
        valid_mask &= arr != nodata
    nonzero_mask = valid_mask & (arr != 0)
    valid_values = arr[nonzero_mask]
    if valid_values.size == 0:
        valid_values = arr[valid_mask]
    if valid_values.size == 0:
        return np.zeros(arr.shape, dtype=np.uint8)
    if valid_values.size > 200_000:
        idx = np.random.choice(valid_values.size, 80_000, replace=False)
        sample = valid_values[idx]
    else:
        sample = valid_values
    low, high = np.percentile(sample, [low_percentile, high_percentile])
    if not np.isfinite(low) or not np.isfinite(high) or high <= low:
        low = float(valid_values.min())
        high = float(valid_values.max())
    if not np.isfinite(low) or not np.isfinite(high) or high <= low:
        return np.zeros(arr.shape, dtype=np.uint8)
    output = (arr - low) * 255.0 / (high - low)
    output[~np.isfinite(output)] = 0
    output[~valid_mask] = 0
    if nodata is not None:
        output[arr == nodata] = 0
    return np.clip(output, 0, 255).astype(np.uint8)


def get_global_stretch_limits(src, band=1):
    cache_key = f"{src.name}:{band}:{src.width}:{src.height}:{src.files[0] if src.files else ''}"
    cached = _cache_get(auto_stretch_cache, cache_key)
    if cached is not None:
        return cached
    with stretch_compute_lock:
        cached = _cache_get(auto_stretch_cache, cache_key)
        if cached is not None:
            return cached
        preview = read_preview_band(src, band=band, max_size=768)
        original_mask = np.ma.getmaskarray(preview)
        arr = np.asarray(np.ma.filled(preview, np.nan), dtype=np.float32)
        valid_mask = np.isfinite(arr) & ~original_mask
        if src.nodata is not None:
            valid_mask &= arr != src.nodata
        nonzero_mask = valid_mask & (arr != 0)
        values = arr[nonzero_mask]
        if values.size == 0:
            values = arr[valid_mask]
        if values.size == 0:
            limits = (0.0, 1.0)
        else:
            if values.size > 200_000:
                idx = np.random.choice(values.size, 80_000, replace=False)
                values = values[idx]
            low, high = np.percentile(values, [2, 98])
            if not np.isfinite(low) or not np.isfinite(high) or high <= low:
                low = float(values.min())
                high = float(values.max())
            if not np.isfinite(low) or not np.isfinite(high) or high <= low:
                limits = (0.0, 1.0)
            else:
                limits = (float(low), float(high))
        _cache_set(auto_stretch_cache, cache_key, limits, MAX_STRETCH_CACHE)
        return limits


def manual_or_auto_stretch(data, nodata=None, min_val=None, max_val=None):
    if min_val is None or max_val is None or max_val <= min_val:
        return brighten_preview(data, nodata=nodata)
    original_mask = np.ma.getmaskarray(data)
    arr = np.asarray(np.ma.filled(data, np.nan), dtype=np.float32)
    valid_mask = np.isfinite(arr) & ~original_mask
    if nodata is not None:
        valid_mask &= arr != nodata
    output = (np.clip(arr, min_val, max_val) - min_val) * 255.0 / (max_val - min_val)
    output[~np.isfinite(output)] = 0
    output[~valid_mask] = 0
    return np.clip(output, 0, 255).astype(np.uint8)


def jpeg_response(image, quality=JPEG_QUALITY, extra_headers=None):
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=quality, optimize=True, progressive=True)
    headers = {"Cache-Control": "public, max-age=3600"}
    if extra_headers:
        headers.update(extra_headers)
    return Response(
        content=buffer.getvalue(),
        media_type="image/jpeg",
        headers=headers,
    )


def raster_read_window(read_fn):
    with raster_read_semaphore:
        return read_fn()


@app.post("/api/upload-chunk")
async def upload_chunk(file: UploadFile = File(...), upload_id: str = Form(...), chunk_index: int = Form(...)):
    if chunk_index < 0:
        raise HTTPException(status_code=400, detail="Invalid chunk index")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty chunk")
    with upload_lock:
        state = upload_chunks.get(upload_id)
        if state is None:
            temp_path = STORAGE_DIR / f".upload_{upload_id}.part"
            state = {"path": temp_path, "indices": set()}
            upload_chunks[upload_id] = state
        else:
            temp_path = state["path"]
        mode = "r+b" if temp_path.exists() else "w+b"
        with open(temp_path, mode) as output:
            output.seek(chunk_index * UPLOAD_CHUNK_SIZE)
            output.write(data)
            output.flush()
        state["indices"].add(chunk_index)
    return {"status": "ok", "chunk_index": chunk_index}


@app.post("/api/upload-complete")
def upload_complete(upload_id: str = Form(...), filename: str = Form(...), total_chunks: int = Form(...), container_name: str = Form(...)):
    if total_chunks <= 0:
        raise HTTPException(status_code=400, detail="Invalid chunk count")
    with upload_lock:
        state = upload_chunks.get(upload_id)
        if state is None:
            raise HTTPException(status_code=400, detail="Upload ID not found")
        indices = state["indices"]
        if len(indices) != total_chunks or any(i not in indices for i in range(total_chunks)):
            raise HTTPException(status_code=400, detail="Missing chunks")
        temp_path = Path(state["path"])
    safe_filename = Path(filename).name
    safe_container = Path(container_name).name
    container_dir = STORAGE_DIR / safe_container
    container_dir.mkdir(exist_ok=True)
    final_path = container_dir / safe_filename
    status_key = f"{safe_container}/{safe_filename}"
    try:
        temp_path.replace(final_path)
        cleanup_old_files(max_files=15, max_total_gb=10.0)
        return {"status": "ok", "file_path": status_key, "filename": safe_filename, "container": safe_container, "preview_ready": False}
    except Exception as e:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        with upload_lock:
            upload_chunks.pop(upload_id, None)


@app.delete("/api/files/{filename:path}")
def delete_file(filename: str):
    file_path = validate_file_exists(filename)
    file_path.unlink(missing_ok=True)
    clear_analysis_cache()
    return {"status": "deleted", "filename": filename}


@app.get("/api/health")
def health_check():
    return {"status": "healthy", "storage": str(STORAGE_DIR), "cached_stretch": len(auto_stretch_cache)}


@app.get("/api/files")
def list_files():
    containers = {}
    for item in STORAGE_DIR.iterdir():
        if item.is_dir():
            files = sorted(f"{item.name}/{f.name}" for f in item.iterdir() if f.is_file() and f.suffix.lower() in {".tif", ".tiff"})
            if files:
                containers[item.name] = files
        elif item.is_file() and item.suffix.lower() in {".tif", ".tiff"}:
            containers.setdefault("_root", []).append(item.name)
    return JSONResponse(content={"containers": containers})


@app.get("/api/metadata")
def get_metadata(filename: str = Query(...)):
    file_path = validate_file_exists(filename)
    try:
        with rasterio.open(file_path) as src:
            return {
                "filename": filename,
                "width": src.width,
                "height": src.height,
                "bands": src.count,
                "dtype": src.dtypes[0],
                "nodata": src.nodata,
                "crs": str(src.crs) if src.crs else None,
                "transform": list(src.transform) if src.transform else None,
            }
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.get("/api/fast-overview")
def get_fast_overview(filename: str = Query(...), band: int = Query(1), max_size: int = Query(400)):
    max_size = max(200, min(int(max_size), 480))
    file_path = validate_file_exists(filename)
    try:
        def _read():
            with rasterio.Env(GDAL_NUM_THREADS="1", GDAL_CACHEMAX=64):
                with rasterio.open(file_path) as src:
                    if band < 1 or band > src.count:
                        raise HTTPException(status_code=400, detail="Invalid band")
                    out_w, out_h = preview_dimensions(src.width, src.height, max_size)
                    data = src.read(band, out_shape=(out_h, out_w), resampling=Resampling.cubic, masked=True)
                    display_data = brighten_preview(data, nodata=src.nodata)
                    return Image.fromarray(display_data, mode="L").convert("RGB")
        image = raster_read_window(_read)
        return jpeg_response(image, quality=50)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.get("/api/overview")
def get_overview(filename: str = Query(...), band: int = Query(1), min_val: Optional[float] = Query(None), max_val: Optional[float] = Query(None), max_size: int = Query(500)):
    max_size = max(200, min(int(max_size), 600))
    try:
        file_path = validate_file_exists(filename)
        with rasterio.open(file_path) as src:
            if band < 1 or band > src.count:
                raise HTTPException(status_code=400, detail="Invalid band")
            data = read_preview_band(src, band=band, max_size=max_size)
            if min_val is None or max_val is None or max_val <= min_val:
                display_data = brighten_preview(data, nodata=src.nodata)
            else:
                display_data = manual_or_auto_stretch(data, src.nodata, min_val, max_val)
            image = Image.fromarray(display_data, mode="L").convert("RGB")
            return jpeg_response(image, quality=65)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.get("/api/thumbnail")
def get_thumbnail(filename: str = Query(...), band: int = Query(1)):
    try:
        file_path = validate_file_exists(filename)
        with rasterio.open(file_path) as src:
            data = read_preview_band(src, band=band, max_size=THUMBNAIL_MAX_SIZE)
            display_data = brighten_preview(data, nodata=src.nodata)
            image = Image.fromarray(display_data, mode="L").convert("RGB")
            return jpeg_response(image, quality=60)
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.get("/api/image")
def get_image(filename: str = Query(...), band: int = Query(1), min_val: Optional[float] = Query(None), max_val: Optional[float] = Query(None), max_size: int = Query(800)):
    try:
        file_path = validate_file_exists(filename)
        with rasterio.open(file_path) as src:
            if band < 1 or band > src.count:
                raise HTTPException(status_code=400, detail="Invalid band")
            data = read_preview_band(src, band=band, max_size=max_size)
            display_data = manual_or_auto_stretch(data, src.nodata, min_val, max_val)
            image = Image.fromarray(display_data, mode="L").convert("RGB")
            return jpeg_response(image, quality=JPEG_QUALITY)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.get("/api/tile")
def get_tile(
    filename: str = Query(...),
    z: int = Query(...),
    x: int = Query(...),
    y: int = Query(...),
    band: int = Query(1),
    min_val: Optional[float] = Query(None),
    max_val: Optional[float] = Query(None),
):
    file_path = validate_file_exists(filename)
    try:
        with rasterio.open(file_path) as src:
            if band < 1 or band > src.count:
                raise HTTPException(status_code=400, detail="Invalid band")
            if z < 0 or x < 0 or y < 0:
                raise HTTPException(status_code=400, detail="Invalid tile coordinates")

            max_dim = max(src.width, src.height, 1)
            max_level = max(0, int(math.ceil(math.log2(max(max_dim / TILE_SIZE, 1)))))
            if z > max_level:
                return Response(status_code=204)

            source_scale = 2 ** (max_level - z)
            tile_width = TILE_SIZE * source_scale
            tile_height = TILE_SIZE * source_scale
            left = x * tile_width
            top = y * tile_height
            right = min(src.width, left + tile_width)
            bottom = min(src.height, top + tile_height)

            if left >= src.width or top >= src.height or right <= left or bottom <= top:
                return Response(status_code=204)

            window = Window(
                col_off=left,
                row_off=top,
                width=right - left,
                height=bottom - top,
            )

            # ---------- Fast path: use an existing overview when possible ----------
            data = None
            if source_scale > 1:
                overviews = src.overviews(band)
                if overviews:
                    # Choose the overview that is closest to (but not coarser than) the needed scale
                    best_ovr_idx = None
                    for i, ovr_factor in enumerate(overviews):
                        if ovr_factor <= source_scale * 1.6:
                            best_ovr_idx = i
                    if best_ovr_idx is not None:
                        try:
                            data = src.read(
                                band,
                                window=window,
                                out_shape=(TILE_SIZE, TILE_SIZE),
                                resampling=Resampling.nearest,
                                overview_level=best_ovr_idx,
                                masked=True,
                            )
                        except Exception:
                            data = None  # fall back to full-resolution read

            # ---------- Normal path (or fallback) ----------
            # Read ONLY this requested tile window. The complete GeoTIFF is
            # never read into memory or transferred to the browser.
            if data is None:
                resampling = (
                    Resampling.nearest if source_scale == 1 else Resampling.average
                )
                data = src.read(
                    band,
                    window=window,
                    out_shape=(TILE_SIZE, TILE_SIZE),
                    resampling=resampling,
                    masked=True,
                )

            # Stretch
            if min_val is None or max_val is None or max_val <= min_val:
                low, high = get_global_stretch_limits(src, band=band)
                display_data = manual_or_auto_stretch(data, src.nodata, low, high)
            else:
                display_data = manual_or_auto_stretch(data, src.nodata, min_val, max_val)

            output = BytesIO()
            Image.fromarray(display_data, mode="L").save(
                output, format="JPEG", quality=92, subsampling=0, optimize=False
            )
            return Response(
                content=output.getvalue(),
                media_type="image/jpeg",
                headers={
                    "Cache-Control": "public, max-age=3600",
                    "X-Tile-Level": str(z),
                    "X-Tile-Source-Scale": str(source_scale),
                },
            )
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Failed to render tile: {str(error)}")


@app.get("/api/rgb-overview")
def get_rgb_overview(r_file: str = Query(...), g_file: str = Query(...), b_file: str = Query(...), r_band: int = Query(1), g_band: int = Query(1), b_band: int = Query(1), r_min: Optional[float] = Query(None), r_max: Optional[float] = Query(None), g_min: Optional[float] = Query(None), g_max: Optional[float] = Query(None), b_min: Optional[float] = Query(None), b_max: Optional[float] = Query(None), max_size: int = Query(400)):
    max_size = max(120, min(int(max_size), 500))
    try:
        r_path = validate_file_exists(r_file.split("::band")[0] if "::band" in r_file else r_file)
        g_path = validate_file_exists(g_file.split("::band")[0] if "::band" in g_file else g_file)
        b_path = validate_file_exists(b_file.split("::band")[0] if "::band" in b_file else b_file)
        with rasterio.open(r_path) as r_src, rasterio.open(g_path) as g_src, rasterio.open(b_path) as b_src:
            if r_band < 1 or r_band > r_src.count: raise HTTPException(status_code=400, detail="Invalid red band")
            if g_band < 1 or g_band > g_src.count: raise HTTPException(status_code=400, detail="Invalid green band")
            if b_band < 1 or b_band > b_src.count: raise HTTPException(status_code=400, detail="Invalid blue band")
            out_w, out_h = preview_dimensions(r_src.width, r_src.height, max_size)
            r_data = r_src.read(r_band, out_shape=(out_h, out_w), resampling=Resampling.average, masked=True)
            g_data = g_src.read(g_band, out_shape=(out_h, out_w), resampling=Resampling.average, masked=True)
            b_data = b_src.read(b_band, out_shape=(out_h, out_w), resampling=Resampling.average, masked=True)
            red = brighten_preview(r_data, r_src.nodata) if (r_min is None or r_max is None or r_max <= r_min) else manual_or_auto_stretch(r_data, r_src.nodata, r_min, r_max)
            green = brighten_preview(g_data, g_src.nodata) if (g_min is None or g_max is None or g_max <= g_min) else manual_or_auto_stretch(g_data, g_src.nodata, g_min, g_max)
            blue = brighten_preview(b_data, b_src.nodata) if (b_min is None or b_max is None or b_max <= b_min) else manual_or_auto_stretch(b_data, b_src.nodata, b_min, b_max)
            image = Image.fromarray(np.dstack((red, green, blue)), mode="RGB")
            return jpeg_response(image, quality=60)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.get("/api/rgb-tile")
def get_rgb_tile(r_file: str = Query(...), g_file: str = Query(...), b_file: str = Query(...), r_band: int = Query(1), g_band: int = Query(1), b_band: int = Query(1), z: int = Query(...), x: int = Query(...), y: int = Query(...), r_min: Optional[float] = Query(None), r_max: Optional[float] = Query(None), g_min: Optional[float] = Query(None), g_max: Optional[float] = Query(None), b_min: Optional[float] = Query(None), b_max: Optional[float] = Query(None)):
    r_path = validate_file_exists(r_file.split("::band")[0] if "::band" in r_file else r_file)
    g_path = validate_file_exists(g_file.split("::band")[0] if "::band" in g_file else g_file)
    b_path = validate_file_exists(b_file.split("::band")[0] if "::band" in b_file else b_file)
    try:
        with rasterio.open(r_path) as r_src, rasterio.open(g_path) as g_src, rasterio.open(b_path) as b_src:
            if r_band < 1 or r_band > r_src.count: raise HTTPException(status_code=400, detail="Invalid red band")
            if g_band < 1 or g_band > g_src.count: raise HTTPException(status_code=400, detail="Invalid green band")
            if b_band < 1 or b_band > b_src.count: raise HTTPException(status_code=400, detail="Invalid blue band")
            if z < 0 or x < 0 or y < 0:
                raise HTTPException(status_code=400, detail="Invalid tile coordinates")
            max_dim = max(r_src.width, r_src.height, 1)
            max_level = max(0, int(math.ceil(math.log2(max(max_dim / TILE_SIZE, 1)))))
            if z > max_level:
                return Response(status_code=204)
            source_scale = 2 ** (max_level - z)
            tile_width = TILE_SIZE * source_scale
            tile_height = TILE_SIZE * source_scale
            left = x * tile_width
            top = y * tile_height
            right = min(r_src.width, left + tile_width)
            bottom = min(r_src.height, top + tile_height)
            if left >= r_src.width or top >= r_src.height or right <= left or bottom <= top:
                return Response(status_code=204)

            def read_ch(src, band):
                window = Window(col_off=left, row_off=top, width=min(right, src.width) - left, height=min(bottom, src.height) - top)
                resampling = Resampling.nearest if source_scale == 1 else Resampling.cubic
                return src.read(band, window=window, out_shape=(TILE_SIZE, TILE_SIZE), resampling=resampling, masked=True)

            def stretch_ch(data, src, band, lo, hi):
                if lo is None or hi is None or hi <= lo:
                    lo, hi = get_global_stretch_limits(src, band=band)
                return manual_or_auto_stretch(data, src.nodata, lo, hi)

            red = stretch_ch(read_ch(r_src, r_band), r_src, r_band, r_min, r_max)
            green = stretch_ch(read_ch(g_src, g_band), g_src, g_band, g_min, g_max)
            blue = stretch_ch(read_ch(b_src, b_band), b_src, b_band, b_min, b_max)
            output = BytesIO()
            Image.fromarray(np.dstack((red, green, blue)), mode="RGB").save(output, format="JPEG", quality=95, subsampling=0, optimize=False)
            return Response(content=output.getvalue(), media_type="image/jpeg", headers={"Cache-Control": "public, max-age=3600", "X-Tile-Level": str(z), "X-Tile-Source-Scale": str(source_scale)})
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.get("/api/rgb-composite")
def get_rgb_composite(r_file: str = Query(...), g_file: str = Query(...), b_file: str = Query(...), r_band: int = Query(1), g_band: int = Query(1), b_band: int = Query(1), r_min: Optional[float] = Query(None), r_max: Optional[float] = Query(None), g_min: Optional[float] = Query(None), g_max: Optional[float] = Query(None), b_min: Optional[float] = Query(None), b_max: Optional[float] = Query(None), max_size: int = Query(800)):
    try:
        r_path = validate_file_exists(r_file.split("::band")[0] if "::band" in r_file else r_file)
        g_path = validate_file_exists(g_file.split("::band")[0] if "::band" in g_file else g_file)
        b_path = validate_file_exists(b_file.split("::band")[0] if "::band" in b_file else b_file)
        with rasterio.open(r_path) as r_src, rasterio.open(g_path) as g_src, rasterio.open(b_path) as b_src:
            if r_band < 1 or r_band > r_src.count: raise HTTPException(status_code=400, detail="Invalid red band")
            if g_band < 1 or g_band > g_src.count: raise HTTPException(status_code=400, detail="Invalid green band")
            if b_band < 1 or b_band > b_src.count: raise HTTPException(status_code=400, detail="Invalid blue band")
            out_w, out_h = preview_dimensions(r_src.width, r_src.height, max_size)
            r_data = r_src.read(r_band, out_shape=(out_h, out_w), resampling=Resampling.average, masked=True)
            g_data = g_src.read(g_band, out_shape=(out_h, out_w), resampling=Resampling.average, masked=True)
            b_data = b_src.read(b_band, out_shape=(out_h, out_w), resampling=Resampling.average, masked=True)
            red = manual_or_auto_stretch(r_data, r_src.nodata, r_min, r_max)
            green = manual_or_auto_stretch(g_data, g_src.nodata, g_min, g_max)
            blue = manual_or_auto_stretch(b_data, b_src.nodata, b_min, b_max)
            image = Image.fromarray(np.dstack((red, green, blue)), mode="RGB")
            return jpeg_response(image, quality=JPEG_QUALITY)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.get("/api/histogram")
def get_histogram(filename: str = Query(...), band: int = Query(1), bins: int = Query(32)):
    file_path = validate_file_exists(filename)
    try:
        with rasterio.open(file_path) as src:
            if band < 1 or band > src.count:
                raise HTTPException(status_code=400, detail="Invalid band")
            data = src.read(band, masked=True)
            valid = data.compressed()
            if valid.size == 0:
                raise HTTPException(status_code=400, detail="No valid pixels")
            if valid.size > 400_000:
                idx = np.random.choice(valid.size, 150_000, replace=False)
                valid = valid[idx]
            hist, bin_edges = np.histogram(valid, bins=bins)
            return {"filename": filename, "band": band, "bins": bins, "counts": hist.tolist(), "min": float(valid.min()), "max": float(valid.max()), "mean": float(valid.mean()), "std": float(valid.std()), "binEdges": bin_edges.tolist()}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.post("/api/roi-analysis")
def analyze_roi(payload: dict = Body(...)):
    filename = str(payload.get("filename", ""))
    file_path = validate_file_exists(filename)
    try:
        x = int(payload.get("x", -1))
        y = int(payload.get("y", -1))
        width = int(payload.get("width", 0))
        height = int(payload.get("height", 0))
        if x < 0 or y < 0 or width <= 0 or height <= 0:
            raise HTTPException(status_code=400, detail="ROI coordinates and dimensions must be positive")

        with rasterio.open(file_path) as src:
            if x + width > src.width or y + height > src.height:
                raise HTTPException(status_code=400, detail="ROI extends beyond raster bounds")

            window = Window(col_off=x, row_off=y, width=width, height=height)
            band_stats = []
            histograms = []
            for band in range(1, src.count + 1):
                data = src.read(band, window=window, masked=True)
                values = np.asarray(data.compressed(), dtype=np.float64)
                values = values[np.isfinite(values)]
                if values.size:
                    band_stats.append({
                        "band": band,
                        "count": int(values.size),
                        "min": float(values.min()),
                        "max": float(values.max()),
                        "mean": float(values.mean()),
                        "median": float(np.median(values)),
                        "std": float(values.std()),
                    })
                    counts, edges = np.histogram(values, bins=32)
                    histograms.append({"band": band, "counts": counts.tolist(), "binEdges": edges.tolist()})
                else:
                    band_stats.append({
                        "band": band, "count": 0, "min": None, "max": None,
                        "mean": None, "median": None, "std": None,
                    })
                    histograms.append({"band": band, "counts": [0] * 32, "binEdges": []})

            extent = rasterio.windows.bounds(window, src.transform)
            geographic_extent = None
            if src.crs:
                try:
                    from rasterio.warp import transform_bounds
                    geographic_extent = transform_bounds(src.crs, "EPSG:4326", *extent, densify_pts=21)
                except Exception:
                    geographic_extent = None

            return {
                "filename": filename,
                "roi": {
                    "x": x, "y": y, "width": width, "height": height,
                    "pixel_count": width * height,
                },
                "extent": {
                    "crs": str(src.crs) if src.crs else None,
                    "bounds": list(extent),
                    "geographic_bounds": list(geographic_extent) if geographic_extent else None,
                },
                "bands": band_stats,
                "histograms": histograms,
            }
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.post("/api/roi-ai-analysis")
def analyze_roi_with_ai(payload: dict = Body(...)):
    """
    Send already-computed ROI statistics to OpenAI for interpretation.

    Scientific calculations are performed by Rasterio/NumPy before this
    endpoint is called. The AI only interprets the supplied statistics.
    """
    api_key = (
        os.environ.get("OPENAI_API_KEY")
        or os.environ.get("AI_API_KEY")
    )

    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=(
                "OpenAI API key is not configured. "
                "Set OPENAI_API_KEY in the backend environment."
            ),
        )

    roi = payload.get("roi")
    bands = payload.get("bands")

    if not isinstance(roi, dict):
        raise HTTPException(
            status_code=400,
            detail="ROI information is required."
        )

    if not isinstance(bands, list) or not bands:
        raise HTTPException(
            status_code=400,
            detail="Band statistics are required."
        )

    model = os.environ.get("AI_MODEL", "gpt-5.6-sol")

    analysis_data = {
        "roi": roi,
        "extent": payload.get("extent"),
        "bands": bands,
    }

    system_prompt = """
You are an expert remote-sensing image analyst.

You are given statistics calculated directly from a GeoTIFF ROI
using Rasterio and NumPy.

Your job is ONLY to interpret the supplied measurements.

Rules:
- Do not invent measurements.
- Do not invent bands.
- Do not claim a land-cover class with certainty unless the supplied
  measurements support it.
- Explain important cross-band patterns.
- Mention unusual values or variability when relevant.
- Clearly distinguish observation from interpretation.
- Keep the answer useful for a remote-sensing engineer.
- Use the exact numeric values supplied when discussing measurements.
"""

    user_prompt = (
        "Analyze the following remote-sensing ROI statistics.\n\n"
        + json.dumps(analysis_data, indent=2, allow_nan=False)
    )

    request_body = {
        "model": model,
        "input": [
            {
                "role": "system",
                "content": [
                    {
                        "type": "input_text",
                        "text": system_prompt,
                    }
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": user_prompt,
                    }
                ],
            },
        ],
    }

    request = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(request_body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            result = json.loads(
                response.read().decode("utf-8")
            )

        # Responses API normally provides output_text.
        analysis = result.get("output_text")

        # Defensive fallback in case output_text is not present.
        if not analysis:
            output_items = result.get("output", [])

            parts = []

            for item in output_items:
                if item.get("type") != "message":
                    continue

                for content in item.get("content", []):
                    if content.get("type") == "output_text":
                        text_value = content.get("text")
                        if text_value:
                            parts.append(text_value)

            analysis = "\n".join(parts).strip()

        if not analysis:
            raise HTTPException(
                status_code=502,
                detail="OpenAI returned an empty analysis."
            )

        return {
            "success": True,
            "analysis": analysis,
            "model": model,
        }

    except urllib.error.HTTPError as error:
        try:
            error_body = error.read().decode("utf-8")
        except Exception:
            error_body = ""

        print(
            f"OpenAI HTTP error {error.code}: {error_body}"
        )

        raise HTTPException(
            status_code=502,
            detail=(
                f"OpenAI returned HTTP {error.code}. "
                f"{error_body[:500]}"
            ),
        )

    except urllib.error.URLError as error:
        print(f"OpenAI connection error: {error}")

        raise HTTPException(
            status_code=502,
            detail=f"Could not connect to OpenAI: {error}",
        )

    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=502,
            detail=f"Invalid response from OpenAI: {error}",
        )

    except HTTPException:
        raise

    except Exception as error:
        print(f"ROI AI error: {error}")

        raise HTTPException(
            status_code=500,
            detail=f"ROI AI analysis failed: {error}",
        )


@app.get("/api/pixel-value")
def get_pixel_value(filename: str = Query(...), x: float = Query(...), y: float = Query(...), band: int = Query(1)):
    file_path = validate_file_exists(filename)
    try:
        with rasterio.open(file_path) as src:
            if band < 1 or band > src.count:
                raise HTTPException(status_code=400, detail="Invalid band")
            col = int(np.clip(x, 0, src.width - 1))
            row = int(np.clip(y, 0, src.height - 1))
            window = Window(col_off=col, row_off=row, width=1, height=1)
            data = src.read(band, window=window, masked=True)
            value = float(data[0, 0]) if data.size > 0 else None
            try:
                lon, lat = src.xy(row, col)
            except Exception:
                lon, lat = None, None
            return {"filename": filename, "band": band, "x": col, "y": row, "value": value, "longitude": lon, "latitude": lat, "crs": str(src.crs) if src.crs else None}
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.get("/api/profile-plot")
def get_profile_plot(filename: str = Query(...), x0: float = Query(...), y0: float = Query(...), x1: float = Query(...), y1: float = Query(...), band: int = Query(1)):
    file_path = validate_file_exists(filename)
    try:
        with rasterio.open(file_path) as src:
            if band < 1 or band > src.count:
                raise HTTPException(status_code=400, detail="Invalid band")
            distance = math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2)
            num_points = max(10, min(int(distance), 400))
            x_values = np.linspace(x0, x1, num_points)
            y_values = np.linspace(y0, y1, num_points)
            sample_points = []
            for x, y in zip(x_values, y_values):
                col = int(np.clip(x, 0, src.width - 1))
                row = int(np.clip(y, 0, src.height - 1))
                lon, lat = src.xy(row, col)
                sample_points.append((lon, lat))
            values = [float(item[0]) for item in src.sample(sample_points, indexes=band)]
            return {"filename": filename, "band": band, "start": {"x": x0, "y": y0}, "end": {"x": x1, "y": y1}, "values": values, "min": float(min(values)), "max": float(max(values))}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.get("/api/scatter-plot")
def get_scatter_plot(filename: str = Query(...), x_band: int = Query(1), y_file: str = Query(...), y_band: int = Query(1)):
    try:
        x_path = validate_file_exists(filename)
        y_path = validate_file_exists(y_file)
        with rasterio.open(x_path) as x_src, rasterio.open(y_path) as y_src:
            if x_band < 1 or x_band > x_src.count or y_band < 1 or y_band > y_src.count:
                raise HTTPException(status_code=400, detail="Invalid band")
            out_w, out_h = preview_dimensions(x_src.width, x_src.height, 700)
            x_data = x_src.read(x_band, out_shape=(out_h, out_w), resampling=Resampling.nearest, masked=True)
            y_data = y_src.read(y_band, out_shape=(out_h, out_w), resampling=Resampling.nearest, masked=True)
            x_values = np.asarray(np.ma.filled(x_data, np.nan)).flatten()
            y_values = np.asarray(np.ma.filled(y_data, np.nan)).flatten()
            valid = np.isfinite(x_values) & np.isfinite(y_values)
            x_values, y_values = x_values[valid], y_values[valid]
            if x_values.size == 0:
                raise HTTPException(status_code=400, detail="No valid pixels")
            if x_values.size > 800:
                idx = np.random.choice(x_values.size, 800, replace=False)
                x_values, y_values = x_values[idx], y_values[idx]
            points = [{"x": float(x), "y": float(y)} for x, y in zip(x_values, y_values)]
            return {"x_file": filename, "y_file": y_file, "x_band": x_band, "y_band": y_band, "points": points, "xMin": float(x_values.min()), "xMax": float(x_values.max()), "yMin": float(y_values.min()), "yMax": float(y_values.max())}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
