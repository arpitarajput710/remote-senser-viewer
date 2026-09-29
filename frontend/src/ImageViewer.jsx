import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import axios from "axios";
import OpenSeadragon from "openseadragon";
import { fromBlob } from "geotiff";

const getApiUrl = () => {
  if (typeof window !== "undefined" && window.location.hostname.includes("github.dev")) {
    const hostname = window.location.hostname;
    const backendHostname = hostname.replace(/-\d+\.app\.github\.dev$/, "-8000.app.github.dev");
    return `${window.location.protocol}//${backendHostname}/api`;
  }
  return "http://127.0.0.1:8000/api";
};

const API = getApiUrl();
const TILE_SIZE = 512;

const computeMaxLevel = (width, height) => {
  const maxDim = Math.max(width, height, 1);
  return Math.max(0, Math.ceil(Math.log2(Math.max(maxDim / TILE_SIZE, 1))));
};

async function uploadFileChunked(file, containerName, onProgress) {
  // Small requests are more reliable through the GitHub Codespaces proxy.
  // Upload happens in the background, so the UI never waits for this step.
  const CHUNK_SIZE = 2 * 1024 * 1024;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const CONCURRENCY = 4;
  const completed = new Set();

  console.log(`[Upload] ${file.name} – ${(file.size / 1024 / 1024).toFixed(1)} MB – ${totalChunks} chunks`);

  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= totalChunks) return;
      const start = index * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const chunk = file.slice(start, end);
      let lastError = null;

      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const formData = new FormData();
          formData.append("file", chunk, file.name);
          formData.append("upload_id", uploadId);
          formData.append("chunk_index", String(index));
          const res = await fetch(`${API}/upload-chunk`, { method: "POST", body: formData });
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
          completed.add(index);
          if (onProgress) onProgress(Math.round((completed.size / totalChunks) * 100));
          break;
        } catch (err) {
          lastError = err;
          if (attempt < 5) await new Promise((r) => setTimeout(r, Math.min(5000, 500 * attempt)));
        }
      }
      if (!completed.has(index)) throw new Error(`Chunk ${index} failed: ${lastError?.message || "unknown error"}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, totalChunks) }, worker));

  const completeForm = new FormData();
  completeForm.append("upload_id", uploadId);
  completeForm.append("filename", file.name);
  completeForm.append("total_chunks", String(totalChunks));
  completeForm.append("container_name", containerName);
  const completeRes = await fetch(`${API}/upload-complete`, { method: "POST", body: completeForm });
  if (!completeRes.ok) throw new Error(`upload-complete failed: ${completeRes.status} ${await completeRes.text()}`);
  return await completeRes.json();
}

async function createLocalGeoTiffPreview(file, maxSize = 640) {
  const tiff = await fromBlob(file);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));

  const rasters = await image.readRasters({
    samples: [0],
    width: outWidth,
    height: outHeight,
    interleave: false,
  });
  const data = rasters[0];

    // Better brightness – use 2% / 98% percentiles (same as backend)
  const samples = [];
  const step = Math.max(1, Math.floor(data.length / 80000));
  for (let i = 0; i < data.length; i += step) {
    const v = Number(data[i]);
    if (Number.isFinite(v) && v !== 0) samples.push(v);
  }
  let min = 0, max = 1;
  if (samples.length > 0) {
    samples.sort((a, b) => a - b);
    const lowIdx = Math.floor(samples.length * 0.02);
    const highIdx = Math.floor(samples.length * 0.98);
    min = samples[lowIdx];
    max = samples[highIdx];
    if (max <= min) {
      min = samples[0];
      max = samples[samples.length - 1];
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    min = 0;
    max = 1;
  }

  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  const rgba = ctx.createImageData(outWidth, outHeight);
  for (let i = 0; i < data.length; i++) {
    const v = Number(data[i]);
    const normalized = Number.isFinite(v) ? Math.max(0, Math.min(255, ((v - min) * 255) / (max - min))) : 0;
    const j = i * 4;
    rgba.data[j] = normalized;
    rgba.data[j + 1] = normalized;
    rgba.data[j + 2] = normalized;
    rgba.data[j + 3] = 255;
  }
  ctx.putImageData(rgba, 0, 0);
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("Could not create preview")), "image/jpeg", 0.78));
  return {
    url: URL.createObjectURL(blob),
    width,
    height,
    bands: image.getSamplesPerPixel() || 1,
    stretchMin: min,
    stretchMax: max,
  };
}

export default function ImageViewer() {
  const [containers, setContainers] = useState({});
  const [pendingFiles, setPendingFiles] = useState([]);
  const [showContainerModal, setShowContainerModal] = useState(false);
  const [fileDisplayNames, setFileDisplayNames] = useState({});
  const [selectedFile, setSelectedFile] = useState(null);
  const [showBandControls, setShowBandControls] = useState(false);
  const [selectedRasterBand, setSelectedRasterBand] = useState(1);
  const [rasterInfo, setRasterInfo] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);

  const [activeContainer, setActiveContainer] = useState(null);
  const [activeRgbContainer, setActiveRgbContainer] = useState("");

  const [rFile, setRFile] = useState("");
  const [gFile, setGFile] = useState("");
  const [bFile, setBFile] = useState("");
  const [rgbBandValues, setRgbBandValues] = useState({ r: 1, g: 1, b: 1 });

  const [showHistogram, setShowHistogram] = useState(false);
  const [histR, setHistR] = useState(null);
  const [histG, setHistG] = useState(null);
  const [histB, setHistB] = useState(null);
  const [histRLoading, setHistRLoading] = useState(false);
  const [histGLoading, setHistGLoading] = useState(false);
  const [histBLoading, setHistBLoading] = useState(false);
  const [histDefaultData, setHistDefaultData] = useState(null);
  const [histDefaultLoading, setHistDefaultLoading] = useState(false);

  const [histDropdownFile, setHistDropdownFile] = useState("");
  const [histActiveChannel, setHistActiveChannel] = useState(null);
  const [histSelectedRange, setHistSelectedRange] = useState(null);
  const [histSelectedChannel, setHistSelectedChannel] = useState(null);
  const [histBoxDrag, setHistBoxDrag] = useState(null);

  const [stretchValues, setStretchValues] = useState({
    default: { min: "", max: "" },
    r: { min: "", max: "" },
    g: { min: "", max: "" },
    b: { min: "", max: "" },
  });

  const [showScatterPlot, setShowScatterPlot] = useState(false);
  const [scatterXFile, setScatterXFile] = useState("");
  const [scatterXBand, setScatterXBand] = useState(1);
  const [scatterXBandCount, setScatterXBandCount] = useState(1);
  const [scatterYFile, setScatterYFile] = useState("");
  const [scatterYBand, setScatterYBand] = useState(1);
  const [scatterYBandCount, setScatterYBandCount] = useState(1);
  const [scatterData, setScatterData] = useState(null);
  const [isScatterLoading, setIsScatterLoading] = useState(false);
  const [scatterError, setScatterError] = useState("");

  const [isProfileMode, setIsProfileMode] = useState(false);
  const [profileStart, setProfileStart] = useState(null);
  const [profileEnd, setProfileEnd] = useState(null);
  const [isDrawingProfile, setIsDrawingProfile] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileData, setProfileData] = useState(null);
  const [isProfileLoading, setIsProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileFile, setProfileFile] = useState("");
  const [selectedProfileBand, setSelectedProfileBand] = useState(1);
  const [profileBandCount, setProfileBandCount] = useState(1);

  const [roiSelection, setRoiSelection] = useState(null);
  const [roiDraft, setRoiDraft] = useState(null);
  const [roiScreenRect, setRoiScreenRect] = useState(null);
  const [isRoiDrawing, setIsRoiDrawing] = useState(false);
  const [showRoiPanel, setShowRoiPanel] = useState(false);
  const [roiAnalysis, setRoiAnalysis] = useState(null);
  const [isRoiLoading, setIsRoiLoading] = useState(false);
  const [selectedRoiBand, setSelectedRoiBand] = useState(1);
  const [roiAiAnalysis, setRoiAiAnalysis] = useState("");
  const [isRoiAiLoading, setIsRoiAiLoading] = useState(false);

  const [isSwipeMode, setIsSwipeMode] = useState(false);
  const [swipeLeftFile, setSwipeLeftFile] = useState("");
  const [swipeRightFile, setSwipeRightFile] = useState("");
  const [swipePosition, setSwipePosition] = useState(50);
  const [isDraggingSwipeDivider, setIsDraggingSwipeDivider] = useState(false);
  const [swipeLeftLoading, setSwipeLeftLoading] = useState(false);
  const [swipeRightLoading, setSwipeRightLoading] = useState(false);

  const [imageUrl, setImageUrl] = useState("");
  const [displayedImageUrl, setDisplayedImageUrl] = useState("");
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [showOverviewInViewport, setShowOverviewInViewport] = useState(false);
  const [osdReady, setOsdReady] = useState(false);
  const [viewMode, setViewMode] = useState("");
  const [toast, setToast] = useState(null);

  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const [miniRect, setMiniRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [showMinimap, setShowMinimap] = useState(true);

  const [mouseInfo, setMouseInfo] = useState(null);
  const mouseInfoTimeoutRef = useRef(null);
  const fallbackDragRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const minimapDragRef = useRef({ active: false });
  const roiDragRef = useRef({ start: null, pointerId: null });

  const containerRef = useRef(null);
  const abortControllerRef = useRef(null);
  const activeObjectUrlRef = useRef(null);
  const thumbnailCacheRef = useRef({});
  const rgbBeforeHistRef = useRef(null);
  const viewStateRef = useRef({});
  const currentViewKeyRef = useRef(null);
  const viewBeforeSwipeRef = useRef(null);
  const stretchStateRef = useRef({});
  const imageHistoryRef = useRef({});
  const historyContextRef = useRef(null);
  const viewerRef = useRef(null);
  const selectedRasterBandRef = useRef(1);
  const osdContainerRef = useRef(null);
  const loadSequenceRef = useRef(0);
  const scatterRequestRef = useRef(0);
  const osdFirstTileRef = useRef(false);
  const lastViewedFileByContainerRef = useRef({});
  const viewerInteractionRef = useRef({ dragging: false, lastX: 0, lastY: 0, moved: false, suppressClick: false });
  const currentRasterSizeRef = useRef({ width: 1, height: 1 });
  const metadataCacheRef = useRef({});
  const localPreviewRef = useRef({});
  const localFileRef = useRef({});
  const localTiffRef = useRef({});
  const localStretchRef = useRef({});
  const uploadPromiseRef = useRef({});
  const uploadFinishedRef = useRef({});
  const containerRgbRef = useRef({});
  const containerStretchRef = useRef({});
  const containerViewStateRef = useRef({});
  const userHasSetViewRef = useRef(false);

  const getHistoryKey = (containerName, filename) => {
    if (!containerName || !filename) return null;
    return `image:${containerName}:${filename}`;
  };

  const RGB_HISTORY_MARKER = "__rgb_composite__";
  const getRgbHistoryKey = (containerName) => getHistoryKey(containerName, RGB_HISTORY_MARKER);
  
  const setRgbHistoryContext = (containerName) => {
    const key = getRgbHistoryKey(containerName);
    historyContextRef.current = key ? { key, containerName, baseFile: RGB_HISTORY_MARKER } : null;
    return key;
  };

  const getSavedRgbHistory = (containerName) => {
    const key = getRgbHistoryKey(containerName);
    return key ? imageHistoryRef.current[key] || null : null;
  };
  const saveCurrentImageHistory = () => {
    const context = historyContextRef.current;
    if (!context?.key) return;

    const record = {
      containerName: context.containerName,
      baseFile: context.baseFile,
      selectedFile: selectedFile || null,
      selectedRasterBand: selectedRasterBandRef.current,
      viewMode,
      rFile,
      gFile,
      bFile,
      rgbBandValues: { ...rgbBandValues },
      stretchValues: cloneStretchValues(stretchValues),
      histDropdownFile,
      histActiveChannel,
      histSelectedRange: histSelectedRange ? { ...histSelectedRange } : null,
      histSelectedChannel,
      showHistogram,
      scale,
      position: { ...position },
      displayedImageUrl,
    };

    if (viewerRef.current?.viewport) {
      try {
        const viewport = viewerRef.current.viewport;
        const center = viewport.getCenter();
        const homeZoom = viewport.getHomeZoom();
        record.osdZoom = viewport.getZoom();
        record.osdCenter = { x: center.x, y: center.y };
        record.osdHomeZoom = homeZoom;
        record.scale = homeZoom > 0 ? viewport.getZoom() / homeZoom : scale;
      } catch (error) {}
    }

    imageHistoryRef.current[context.key] = record;
    if (context.containerName && context.baseFile) {
      lastViewedFileByContainerRef.current[context.containerName] = context.baseFile;
    }
  };

  const getSavedImageHistory = (containerName, filename) => {
    const key = getHistoryKey(containerName, filename);
    return key ? imageHistoryRef.current[key] || null : null;
  };

  const setHistoryContext = (containerName, filename) => {
    const key = getHistoryKey(containerName, filename);
    historyContextRef.current = key ? { key, containerName, baseFile: filename } : null;
    return key;
  };

  const rasterViewKey = (filename) => `raster:${filename}`;
  const compositeViewKey = (r, g, b) => `rgb:${r}:${g}:${b}`;

  const createEmptyStretchValues = () => ({
    default: { min: "", max: "" },
    r: { min: "", max: "" },
    g: { min: "", max: "" },
    b: { min: "", max: "" },
  });

  const cloneStretchValues = useCallback((values) => {
    if (!values) return createEmptyStretchValues();
    return {
      default: { min: values.default?.min ?? "", max: values.default?.max ?? "" },
      r: { min: values.r?.min ?? "", max: values.r?.max ?? "" },
      g: { min: values.g?.min ?? "", max: values.g?.max ?? "" },
      b: { min: values.b?.min ?? "", max: values.b?.max ?? "" },
    };
  }, []);

  const saveFileStretch = (filename, channel, min, max) => {
    if (!filename) return;
    const previousStretch = stretchStateRef.current[filename] || createEmptyStretchValues();
    stretchStateRef.current[filename] = { ...previousStretch, [channel]: { min, max } };
  };

  const getFileStretch = (filename) => {
    if (!filename) return createEmptyStretchValues();
    return cloneStretchValues(stretchStateRef.current[filename]);
  };

  const showToast = (message, type = "error") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  const getDisplayFilename = (filePath) => {
    if (!filePath) return "";
    return filePath.replace(/\\/g, "/").split("/").pop();
  };

  const getDisplayName = useCallback(
    (storageKey) => {
      if (!storageKey) return "";
      return fileDisplayNames[storageKey] || getDisplayFilename(storageKey);
    },
    [fileDisplayNames]
  );

  // Always returns a correct full storage key
const getFullKey = (file) => {
  if (!file) return "";
  // Already contains container → use as-is
  if (file.includes("/")) return file;
  // Otherwise prefix with active container
  return activeContainer ? `${activeContainer}/${file}` : file;
};

  const parseBandKey = (key) => {
    if (!key) return { filename: "", band: 1 };
    if (key.includes("::band")) {
      const [filename, bandPart] = key.split("::band");
      return { filename, band: parseInt(bandPart, 10) || 1 };
    }
    return { filename: key, band: 1 };
  };

  const getContainerForFile = (filename) => {
  if (!filename) return null;
  // If it already has a slash, the part before / is the container
  if (filename.includes("/")) {
    return filename.split("/")[0];
  }
  for (const [containerName, files] of Object.entries(containers)) {
    if (files.includes(filename) || files.includes(`${containerName}/${filename}`)) {
      return containerName;
    }
  }
  return null;
};
const expandMultiBandFile = async (containerName, filePath) => {
  // Disabled - Do not expand multi-band files into multiple entries.
  // Keep only the single original file that the user uploaded.
  return;
};

  const activeFilesPool = useMemo(() => {
    if (activeContainer && containers[activeContainer]) return containers[activeContainer];
    return [];
  }, [activeContainer, containers]);

  const roiSourceFile = selectedFile || rFile || activeFilesPool[0] || "";
  const bandSourceFile = selectedFile || (viewMode === "rgb" ? rFile : "");

  const allFilesList = useMemo(() => Object.values(containers).flat(), [containers]);

  const getThumbnailUrl = useCallback((filePath) => {
  const key = getFullKey(filePath);
  if (!thumbnailCacheRef.current[key]) {
    thumbnailCacheRef.current[key] = `${API}/thumbnail?filename=${encodeURIComponent(key)}`;
  }
  return thumbnailCacheRef.current[key];
}, [activeContainer]);

  const waitForRasterMetadata = async (filename, attempts = 8, delayMs = 250) => {
    if (metadataCacheRef.current[filename]) return metadataCacheRef.current[filename];

    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const res = await axios.get(`${API}/metadata`, { params: { filename }, timeout: 2500 });
        if (res?.data?.width && res?.data?.height) {
          metadataCacheRef.current[filename] = res.data;
          return res.data;
        }
        lastError = new Error("No dimensions");
      } catch (error) {
        lastError = error;
      }
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    throw lastError || new Error("Metadata unavailable");
  };

  useEffect(() => {
    let active = true;
    const updateBandCount = async (file, setCount, setBand) => {
      if (!file) {
        setCount(1);
        setBand(1);
        return;
      }
      try {
        const metadata = await waitForRasterMetadata(getFullKey(file), 3, 180);
        if (active) setCount(Math.max(1, metadata.bands || 1));
      } catch {
        if (active) setCount(1);
      }
    };

    updateBandCount(scatterXFile, setScatterXBandCount, setScatterXBand);
    updateBandCount(scatterYFile, setScatterYBandCount, setScatterYBand);
    updateBandCount(profileFile, setProfileBandCount, setSelectedProfileBand);
    return () => { active = false; };
  }, [scatterXFile, scatterYFile, profileFile, activeContainer]);

  const buildOverviewUrl = (url) => {
  const parsed = new URL(url);

  if (parsed.pathname.endsWith("/rgb-composite")) {
    const params = new URLSearchParams({
      r_file: parsed.searchParams.get("r_file") || "",
      g_file: parsed.searchParams.get("g_file") || "",
      b_file: parsed.searchParams.get("b_file") || "",
      r_band: parsed.searchParams.get("r_band") || "1",
      g_band: parsed.searchParams.get("g_band") || "1",
      b_band: parsed.searchParams.get("b_band") || "1",
      max_size: "480",
    });
    ["r_min", "r_max", "g_min", "g_max", "b_min", "b_max"].forEach((key) => {
      const value = parsed.searchParams.get(key);
      if (value !== null && value !== "") params.set(key, value);
    });
    return `${API}/rgb-overview?${params.toString()}`;
  }

  let filename = parsed.searchParams.get("filename") || "";
  let band = parsed.searchParams.get("band") || "1";

  if (filename.includes("::band")) {
    const p = parseBandKey(filename);
    filename = p.filename;
    band = String(p.band);
  }

  // Make sure we always use the full key
  filename = getFullKey(filename);

  const params = new URLSearchParams();
  params.set("filename", filename);
  params.set("band", band);
  params.set("max_size", "480");

  const minVal = parsed.searchParams.get("min_val");
  const maxVal = parsed.searchParams.get("max_val");
  if (minVal) params.set("min_val", minVal);
  if (maxVal) params.set("max_val", maxVal);

  return `${API}/overview?${params.toString()}`;
};

const buildFastPreviewUrl = (url) => {
  const parsed = new URL(url);

  if (parsed.pathname.endsWith("/rgb-composite")) {
    const params = new URLSearchParams({
      r_file: parsed.searchParams.get("r_file") || "",
      g_file: parsed.searchParams.get("g_file") || "",
      b_file: parsed.searchParams.get("b_file") || "",
      r_band: parsed.searchParams.get("r_band") || "1",
      g_band: parsed.searchParams.get("g_band") || "1",
      b_band: parsed.searchParams.get("b_band") || "1",
      max_size: "260",
    });
    ["r_min", "r_max", "g_min", "g_max", "b_min", "b_max"].forEach((key) => {
      const value = parsed.searchParams.get(key);
      if (value !== null && value !== "") params.set(key, value);
    });
    return `${API}/rgb-overview?${params.toString()}`;
  }

  let filename = parsed.searchParams.get("filename") || "";
  let band = parsed.searchParams.get("band") || "1";

  if (filename.includes("::band")) {
    const parsedBand = parseBandKey(filename);
    filename = parsedBand.filename;
    band = String(parsedBand.band);
  }

  if (!filename || !parsed.pathname.endsWith("/image")) return null;

  // Always use full key
  filename = getFullKey(filename);

  return `${API}/fast-overview?filename=${encodeURIComponent(filename)}&band=${band}&max_size=400`;
};

  // ========== FAST OVERVIEW LOADER ==========
  // The overview is intentionally NOT cached in JS. One Object URL is kept only
  // while it is displayed; it is revoked when another image is opened.
  const loadVerifiedOverview = async (url, requestId) => {
    const overviewUrl = buildOverviewUrl(url);
    const fastPreviewUrl = buildFastPreviewUrl(url);
    const deadline = Date.now() + 9000;
    let lastError = null;

    const publishObjectUrl = (objectUrl) => {
      if (requestId !== loadSequenceRef.current) {
        URL.revokeObjectURL(objectUrl);
        return false;
      }
      if (activeObjectUrlRef.current) {
        try { URL.revokeObjectURL(activeObjectUrlRef.current); } catch (_) {}
      }
      activeObjectUrlRef.current = objectUrl;
      setDisplayedImageUrl(objectUrl);
      setShowOverviewInViewport(true);
      setIsImageLoading(false);
      return true;
    };

    const tryFetchImage = async (imageUrl, timeoutMs) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${imageUrl}${imageUrl.includes("?") ? "&" : "?"}_ts=${Date.now()}`, {
          signal: controller.signal,
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob || blob.size === 0) throw new Error("Empty response");
        return URL.createObjectURL(blob);
      } finally {
        window.clearTimeout(timeout);
      }
    };

    // Priority 1: fast overview with retries (target < 10s)
    if (fastPreviewUrl && requestId === loadSequenceRef.current) {
      for (let i = 0; i < 4; i++) {
        if (requestId !== loadSequenceRef.current) return false;
        try {
          const timeout = i === 0 ? 4000 : 2500;
          const objectUrl = await tryFetchImage(fastPreviewUrl, timeout);
          if (publishObjectUrl(objectUrl)) return true;
        } catch (err) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }

    // Priority 2: larger overview while deadline remains
    while (Date.now() < deadline && requestId === loadSequenceRef.current) {
      const remaining = Math.max(400, deadline - Date.now());
      try {
        const objectUrl = await tryFetchImage(overviewUrl, Math.min(3000, remaining));
        if (publishObjectUrl(objectUrl)) return true;
      } catch (err) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (requestId === loadSequenceRef.current) {
      setIsImageLoading(false);
      console.warn("Overview unavailable/slow; continuing with tiled viewer:", lastError);
      // Do not force-hide existing local/server overview
    }
    return false;
  };

  const panFromMinimapPointer = (e, minimapElement) => {
    const viewer = viewerRef.current;
    const { width, height } = currentRasterSizeRef.current;
    if (!viewer?.viewport || !width || !height) return;

    const rect = minimapElement.getBoundingClientRect();
    const rasterAspect = width / height;
    const minimapAspect = rect.width / rect.height;
    let normalizedX = (e.clientX - rect.left) / rect.width;
    let normalizedY = (e.clientY - rect.top) / rect.height;

    if (rasterAspect > minimapAspect) {
      const displayedHeight = minimapAspect / rasterAspect;
      normalizedY = (normalizedY - (1 - displayedHeight) / 2) / displayedHeight;
    } else {
      const displayedWidth = rasterAspect / minimapAspect;
      normalizedX = (normalizedX - (1 - displayedWidth) / 2) / displayedWidth;
    }

    const imagePoint = new OpenSeadragon.Point(
      Math.max(0, Math.min(width, normalizedX * width)),
      Math.max(0, Math.min(height, normalizedY * height))
    );
    userHasSetViewRef.current = true;
    viewer.viewport.panTo(viewer.viewport.imageToViewportCoordinates(imagePoint));
    viewer.viewport.applyConstraints();
  };

  // Calculate the exact part of the raster currently visible in OpenSeadragon.
  // We convert all four viewport corners separately instead of relying only on
  // viewportToImageRectangle(), which can produce incorrect values when the
  // viewer has margins or is constrained during pan/zoom.
  const updateMiniRectFromViewer = (width, height, viewer = viewerRef.current) => {
    if (!viewer?.viewport || !width || !height) return;

    try {
      const bounds = viewer.viewport.getBounds(true);
      const topLeft = viewer.viewport.viewportToImageCoordinates(
        new OpenSeadragon.Point(bounds.x, bounds.y)
      );
      const topRight = viewer.viewport.viewportToImageCoordinates(
        new OpenSeadragon.Point(bounds.x + bounds.width, bounds.y)
      );
      const bottomLeft = viewer.viewport.viewportToImageCoordinates(
        new OpenSeadragon.Point(bounds.x, bounds.y + bounds.height)
      );
      const bottomRight = viewer.viewport.viewportToImageCoordinates(
        new OpenSeadragon.Point(bounds.x + bounds.width, bounds.y + bounds.height)
      );

      const imageLeft = Math.min(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x);
      const imageTop = Math.min(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y);
      const imageRight = Math.max(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x);
      const imageBottom = Math.max(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y);

      const left = Math.max(0, Math.min(1, imageLeft / width));
      const top = Math.max(0, Math.min(1, imageTop / height));
      const right = Math.max(0, Math.min(1, imageRight / width));
      const bottom = Math.max(0, Math.min(1, imageBottom / height));

      setMiniRect({
        left: Math.min(left, right),
        top: Math.min(top, bottom),
        width: Math.max(0.005, Math.min(1, Math.abs(right - left))),
        height: Math.max(0.005, Math.min(1, Math.abs(bottom - top))),
      });
    } catch (error) {
      // Keep the previous rectangle if the viewer is between transitions.
    }
  };

  const buildAndShowTiles = async (tileParams, requestId, restoreViewport = null) => {
    if (viewerInteractionRef.current.cleanup) {
      viewerInteractionRef.current.cleanup();
      viewerInteractionRef.current.cleanup = null;
    }
    if (viewerRef.current) {
      try { viewerRef.current.destroy(); } catch (_) {}
      viewerRef.current = null;
    }

    // Reset all viewer state when switching containers/images.
    // This prevents old minimap rectangle, zoom, and viewport state leaking.
    setMiniRect({ left: 0, top: 0, width: 1, height: 1 });
    try {
      if (osdContainerRef.current) osdContainerRef.current.innerHTML = "";
    } catch (_) {}

    if (!osdContainerRef.current || requestId !== loadSequenceRef.current) return;

    const metaFile = tileParams.type === "rgb" ? tileParams.r : tileParams.file;
    if (!metaFile) return;
    const metaKey = getFullKey(metaFile);

    setOsdReady(false);
    osdFirstTileRef.current = false;

    try {
      // Prefer local dimensions (instant). Fall back to server metadata.
      let width = currentRasterSizeRef.current?.width || 0;
      let height = currentRasterSizeRef.current?.height || 0;
      try {
        const metadata = await waitForRasterMetadata(metaKey);
        width = metadata.width;
        height = metadata.height;
        setRasterInfo(metadata);
      } catch (metaErr) {
        if (!width || !height) {
          console.warn("Metadata not ready yet; waiting for upload:", metaErr?.message || metaErr);
          // Retry a few times while background upload finishes
          for (let i = 0; i < 8 && requestId === loadSequenceRef.current; i++) {
            await new Promise((r) => setTimeout(r, 400));
            try {
              const metadata = await waitForRasterMetadata(metaKey, 2, 200);
              width = metadata.width;
              height = metadata.height;
              setRasterInfo(metadata);
              break;
            } catch (_) {}
          }
        }
      }
      if (!width || !height) {
        console.error("Cannot start tiles without raster dimensions");
        return;
      }
      currentRasterSizeRef.current = { width, height };
      if (!osdContainerRef.current || requestId !== loadSequenceRef.current) return;

      const maxLevel = computeMaxLevel(width, height);

      const buildRasterTileUrl = (level, x, y) => {
        const { filename, band } = parseBandKey(getFullKey(tileParams.file));
        let tileUrl = `${API}/tile?filename=${encodeURIComponent(filename)}&band=${band}&z=${level}&x=${x}&y=${y}`;
        if (tileParams.min !== "" && tileParams.min != null) tileUrl += `&min_val=${encodeURIComponent(tileParams.min)}`;
        if (tileParams.max !== "" && tileParams.max != null) tileUrl += `&max_val=${encodeURIComponent(tileParams.max)}`;
        return tileUrl;
      };

      const buildRgbTileUrl = (level, x, y) => {
        let tileUrl = `${API}/rgb-tile?r_file=${encodeURIComponent(getFullKey(tileParams.r))}&g_file=${encodeURIComponent(getFullKey(tileParams.g))}&b_file=${encodeURIComponent(getFullKey(tileParams.b))}&r_band=${tileParams.rBand}&g_band=${tileParams.gBand}&b_band=${tileParams.bBand}&z=${level}&x=${x}&y=${y}`;
        [["r_min", tileParams.rMin], ["r_max", tileParams.rMax], ["g_min", tileParams.gMin], ["g_max", tileParams.gMax], ["b_min", tileParams.bMin], ["b_max", tileParams.bMax]].forEach(([key, val]) => {
          if (val !== "" && val != null) tileUrl += `&${key}=${encodeURIComponent(val)}`;
        });
        return tileUrl;
      };

      // If the original File is still available in the browser and the
      // background upload has not completed, use the local TIFF as the tile
      // source. OpenSeadragon supports custom asynchronous tile retrieval via
      // downloadTileStart(), so only the requested 512x512 region is decoded.
      const localFile = tileParams.type === "raster" && !uploadFinishedRef.current[metaKey]
        ? localFileRef.current[metaKey]
        : null;
      const useLocalTiles = Boolean(localFile);
      const localTileCache = new Map();

      const getLocalTiffImage = async () => {
        if (!localFile) throw new Error("Local TIFF file is not available");
        if (!localTiffRef.current[metaKey]) {
          localTiffRef.current[metaKey] = (async () => {
            const tiff = await fromBlob(localFile);
            return await tiff.getImage();
          })();
        }
        return localTiffRef.current[metaKey];
      };

      const getLocalStretch = async (image, sampleIndex) => {
        const stretchKey = `${metaKey}:band:${sampleIndex}`;
        if (localStretchRef.current[stretchKey]) return localStretchRef.current[stretchKey];

        const promise = (async () => {
          const nodata = typeof image.getGDALNoData === "function" ? image.getGDALNoData() : null;
          const previewScale = Math.min(1, 768 / Math.max(width, height, 1));
          const previewWidth = Math.max(1, Math.round(width * previewScale));
          const previewHeight = Math.max(1, Math.round(height * previewScale));
          const rasters = await image.readRasters({
            samples: [sampleIndex],
            width: previewWidth,
            height: previewHeight,
            interleave: false,
            resampleMethod: "bilinear",
          });
          const values = rasters[0];
          const samples = [];
          const step = Math.max(1, Math.floor(values.length / 80000));
          for (let i = 0; i < values.length; i += step) {
            const value = Number(values[i]);
            if (!Number.isFinite(value)) continue;
            if (nodata != null && value === Number(nodata)) continue;
            if (value === 0) continue;
            samples.push(value);
          }

          let min = 0;
          let max = 1;
          if (samples.length) {
            samples.sort((a, b) => a - b);
            min = samples[Math.floor(samples.length * 0.02)];
            max = samples[Math.floor(samples.length * 0.98)];
            if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
              min = samples[0];
              max = samples[samples.length - 1];
            }
          }
          if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
            min = 0;
            max = 1;
          }
          return { min, max, nodata };
        })();

        localStretchRef.current[stretchKey] = promise;
        return promise;
      };

      const makeLocalTileCanvas = async (level, x, y) => {
        const sampleIndex = Math.max(0, (Number(tileParams.band) || 1) - 1);
        const cacheKey = `${metaKey}:${sampleIndex}:${tileParams.min || ""}:${tileParams.max || ""}:${level}:${x}:${y}`;
        if (localTileCache.has(cacheKey)) return localTileCache.get(cacheKey);

        const promise = (async () => {
          const image = await getLocalTiffImage();
          const sourceScale = Math.pow(2, maxLevel - level);
          const levelWidth = Math.ceil(width / sourceScale);
          const levelHeight = Math.ceil(height / sourceScale);
          const tileWidth = Math.max(1, Math.min(TILE_SIZE, levelWidth - x * TILE_SIZE));
          const tileHeight = Math.max(1, Math.min(TILE_SIZE, levelHeight - y * TILE_SIZE));
          const sourceX0 = Math.max(0, Math.floor(x * TILE_SIZE * sourceScale));
          const sourceY0 = Math.max(0, Math.floor(y * TILE_SIZE * sourceScale));
          const sourceX1 = Math.min(width, Math.ceil((x * TILE_SIZE + tileWidth) * sourceScale));
          const sourceY1 = Math.min(height, Math.ceil((y * TILE_SIZE + tileHeight) * sourceScale));
          const rasters = await image.readRasters({
            samples: [sampleIndex],
            window: [sourceX0, sourceY0, sourceX1, sourceY1],
            width: tileWidth,
            height: tileHeight,
            interleave: false,
            resampleMethod: sourceScale > 1 ? "bilinear" : "nearest",
          });
          const data = rasters[0];

          let min = tileParams.min !== "" && tileParams.min != null
            ? Number(tileParams.min)
            : NaN;
          let max = tileParams.max !== "" && tileParams.max != null
            ? Number(tileParams.max)
            : NaN;

          if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
            const stretch = await getLocalStretch(image, sampleIndex);
            min = stretch.min;
            max = stretch.max;
          }

          const canvas = document.createElement("canvas");
          canvas.width = tileWidth;
          canvas.height = tileHeight;
          const ctx = canvas.getContext("2d", { willReadFrequently: false });
          const rgba = ctx.createImageData(tileWidth, tileHeight);
          for (let i = 0; i < data.length; i++) {
            const value = Number(data[i]);
            const normalized = Number.isFinite(value)
              ? Math.max(0, Math.min(255, ((value - min) * 255) / (max - min)))
              : 0;
            const j = i * 4;
            rgba.data[j] = normalized;
            rgba.data[j + 1] = normalized;
            rgba.data[j + 2] = normalized;
            rgba.data[j + 3] = 255;
          }
          ctx.putImageData(rgba, 0, 0);
          return ctx;
        })();

        localTileCache.set(cacheKey, promise);
        return promise;
      };

      // Same simple TileSource pattern as the working reference viewer:
      // width/height known → OpenSeadragon opens immediately → tiles on demand.
      const tileSource = {
        width,
        height,
        tileSize: TILE_SIZE,
        tileOverlap: 0,
        minLevel: 0,
        maxLevel,
        getLevelScale(level) {
          return 1 / Math.pow(2, maxLevel - level);
        },
        // OpenSeadragon needs the exact tile count for every pyramid level.
        // Without this, it can keep displaying a low-resolution tile while
        // zooming instead of requesting the native-resolution tiles.
        getNumTiles(level) {
          const scale = this.getLevelScale(level);
          return new OpenSeadragon.Point(
            Math.ceil((width * scale) / TILE_SIZE),
            Math.ceil((height * scale) / TILE_SIZE)
          );
        },
        getTileUrl(level, x, y) {
          if (useLocalTiles) return `local-geotiff://${metaKey}/${level}/${x}/${y}`;
          return tileParams.type === "rgb"
            ? buildRgbTileUrl(level, x, y)
            : buildRasterTileUrl(level, x, y);
        },
        getTilePostData(level, x, y) {
          return useLocalTiles ? { level, x, y } : null;
        },
        getTileHashKey(level, x, y) {
          if (useLocalTiles) return `local-geotiff:${metaKey}:${tileParams.band || 1}:${level}:${x}:${y}`;
          return `${tileParams.type}:${metaKey}:${level}:${x}:${y}`;
        },
        downloadTileStart(context) {
          if (!useLocalTiles) return OpenSeadragon.TileSource.prototype.downloadTileStart.call(this, context);

          const level = context.postData?.level ?? 0;
          const x = context.postData?.x ?? 0;
          const y = context.postData?.y ?? 0;
          makeLocalTileCanvas(level, x, y)
            .then((ctx) => context.finish(ctx, null, "context2d"))
            .catch((error) => {
              console.warn("Local GeoTIFF tile failed:", error);
              context.finish(null, null, error?.message || "Local tile failed");
            });
        },
        downloadTileAbort() {},
      };

      // Clear any leftover OSD children before re-init
      try { osdContainerRef.current.innerHTML = ""; } catch (_) {}

      viewerRef.current = OpenSeadragon({
        element: osdContainerRef.current,
        prefixUrl: "https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/",
        crossOriginPolicy: "Anonymous",
        drawer: "canvas",
        loadTilesWithAjax: true,
        tileSources: tileSource,
        showNavigationControl: false,
        homeFillsViewer: true,
        visibilityRatio: 1,
        constrainDuringPan: true,
        minZoomImageRatio: 0.5,
        maxZoomPixelRatio: 1,
        zoomPerScroll: 1.2,
        animationTime: 0.15,
        mouseNavEnabled: true,
        clickToZoom: false,
        gestureSettingsMouse: {
          clickToZoom: false,
          dblClickToZoom: false,
          dragToPan: true,
          scrollToZoom: true,
          pinchToZoom: true,
        },
        immediateRender: true,
        alwaysBlend: false,
        blendTime: 0,
        imageLoaderLimit: 8,
        maxImageCacheCount: 80,
        timeout: 30000,
      });

      // Let OpenSeadragon own the mouse/touch events. Do not add a React
      // onWheel handler or a second pointer controller here: those handlers
      // can block OSD's event pipeline and prevent tile refinement.
      viewerInteractionRef.current.cleanup = null;

      viewerRef.current.addOnceHandler("open", () => {
        if (requestId !== loadSequenceRef.current) return;

        // New image starts from its own bounds. Do not reuse previous container view.
        viewerRef.current.viewport.goHome(true);
        viewerRef.current.viewport.applyConstraints();
        // The overview must remain visible until OpenSeadragon has actually
        // drawn its first GeoTIFF tile. Hiding it on the `open` event can leave
        // a black viewport because `open` may fire before the first tile.
        setShowOverviewInViewport(true);
        setIsImageLoading(true);
        setOsdReady(true);
        const viewer = viewerRef.current;
        if (viewer) {
          viewer.viewport.goHome(true);
          viewer.viewport.applyConstraints();
          const restore = restoreViewport && Number.isFinite(restoreViewport.osdZoom) && restoreViewport.osdCenter
            ? restoreViewport
            : null;
          requestAnimationFrame(() => {
            if (!viewerRef.current || requestId !== loadSequenceRef.current) return;
            const currentViewer = viewerRef.current;
            currentViewer.viewport.goHome(true);
            currentViewer.viewport.applyConstraints();
            if (restore) {
              currentViewer.viewport.zoomTo(restore.osdZoom, null, true);
              currentViewer.viewport.panTo(new OpenSeadragon.Point(restore.osdCenter.x, restore.osdCenter.y), true);
              currentViewer.viewport.applyConstraints();
            }
            updateMiniRectFromViewer(width, height, currentViewer);
          });
        }
      });

      viewerRef.current.addHandler("viewport-change", () => {
        if (requestId !== loadSequenceRef.current || !viewerRef.current) return;
        const viewer = viewerRef.current;
        const homeZoom = viewer.viewport.getHomeZoom();
        const zoom = viewer.viewport.getZoom();
        setScale(homeZoom > 0 ? zoom / homeZoom : 1);
        updateMiniRectFromViewer(width, height, viewer);
        saveCurrentImageHistory();
      });

      viewerRef.current.addHandler("animation-finish", () => {
        if (requestId !== loadSequenceRef.current || !viewerRef.current) return;
        updateMiniRectFromViewer(width, height, viewerRef.current);
        saveCurrentImageHistory();
      });

      const hideOverviewOnInteraction = () => {
        if (requestId !== loadSequenceRef.current) return;
        if (!osdFirstTileRef.current) return;
        setShowOverviewInViewport(false);
      };

      viewerRef.current.addHandler("canvas-press", hideOverviewOnInteraction);
      viewerRef.current.addHandler("canvas-drag", hideOverviewOnInteraction);
      viewerRef.current.addHandler("zoom", hideOverviewOnInteraction);

      viewerRef.current.addHandler("tile-drawn", () => {
        if (requestId !== loadSequenceRef.current) return;
        osdFirstTileRef.current = true;
        setShowOverviewInViewport(false);
        setIsImageLoading(false);
      });

      viewerRef.current.addHandler("resize", () => {
        const viewer = viewerRef.current;
        if (!viewer || requestId !== loadSequenceRef.current) return;
        viewer.viewport.applyConstraints();
        updateMiniRectFromViewer(width, height, viewer);
      });

      viewerRef.current.addOnceHandler("open-failed", (event) => {
        if (requestId !== loadSequenceRef.current) return;
        console.error("OpenSeadragon open failed:", event?.message || event);
        setOsdReady(false);
      });

      viewerRef.current.addHandler("tile-load-failed", (event) => {
        if (requestId !== loadSequenceRef.current) return;
        console.warn("GeoTIFF tile failed:", event?.message || event);
      });
    } catch (error) {
      console.error("Failed to initialize tiled viewer:", error);
      if (requestId === loadSequenceRef.current) setOsdReady(false);
    }
  };

  const forceCleanViewerState = (keepOverview = false) => {
  if (abortControllerRef.current) {
    try { abortControllerRef.current.abort(); } catch (_) {}
    abortControllerRef.current = null;
  }
  if (viewerInteractionRef.current.cleanup) {
    try { viewerInteractionRef.current.cleanup(); } catch (_) {}
    viewerInteractionRef.current.cleanup = null;
  }
  if (viewerRef.current) {
    try { viewerRef.current.clearOverlays(); } catch (_) {}
    try { viewerRef.current.destroy(); } catch (_) {}
    viewerRef.current = null;
  }
  if (!keepOverview) {
    if (activeObjectUrlRef.current) {
      try { URL.revokeObjectURL(activeObjectUrlRef.current); } catch (_) {}
      activeObjectUrlRef.current = null;
    }
    setDisplayedImageUrl("");
    setShowOverviewInViewport(false);
  }
  setIsImageLoading(!keepOverview);
  setOsdReady(false);
  osdFirstTileRef.current = false;
  if (!keepOverview) {
    setMiniRect({ left: 0, top: 0, width: 1, height: 1 });
  }
};

const loadImage = async (url, viewKey = null, preserveView = false, restoreViewport = null) => {
  // keepOverview when we already show local/saved preview — user sees image immediately
  forceCleanViewerState(Boolean(preserveView));

  const requestId = ++loadSequenceRef.current;
  abortControllerRef.current = new AbortController();

  setImageUrl(url);
  userHasSetViewRef.current = Boolean(restoreViewport);
  currentViewKeyRef.current = viewKey;

  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    setIsImageLoading(false);
    showToast("Invalid image URL", "error");
    return;
  }

  let tileParams = null;
  if (parsed.pathname.endsWith("/rgb-composite")) {
    tileParams = {
      type: "rgb",
      r: parsed.searchParams.get("r_file"),
      g: parsed.searchParams.get("g_file"),
      b: parsed.searchParams.get("b_file"),
      rBand: Number(parsed.searchParams.get("r_band") || 1),
      gBand: Number(parsed.searchParams.get("g_band") || 1),
      bBand: Number(parsed.searchParams.get("b_band") || 1),
      rMin: parsed.searchParams.get("r_min"),
      rMax: parsed.searchParams.get("r_max"),
      gMin: parsed.searchParams.get("g_min"),
      gMax: parsed.searchParams.get("g_max"),
      bMin: parsed.searchParams.get("b_min"),
      bMax: parsed.searchParams.get("b_max"),
    };
  } else if (parsed.pathname.endsWith("/image")) {
    tileParams = {
      type: "raster",
      file: parsed.searchParams.get("filename"),
      band: Number(parsed.searchParams.get("band") || 1),
      min: parsed.searchParams.get("min_val"),
      max: parsed.searchParams.get("max_val"),
    };
  }

  // SAME PATTERN AS WORKING REFERENCE APP:
  // 1) Start tiled viewer immediately (metadata + OpenSeadragon)
  // 2) Overview is optional and must NEVER block tiles
  // Low-res tiles at home zoom are what make "under 10s" work for every image.
  if (tileParams) {
    buildAndShowTiles(tileParams, requestId, restoreViewport);
  }
  // Fire-and-forget overview (does not delay tiles)
  loadVerifiedOverview(url, requestId).catch(() => {});
};

  useEffect(() => {
    if (isSwipeMode && viewerRef.current) {
      viewerRef.current.destroy();
      viewerRef.current = null;
    }
  }, [isSwipeMode]);

  useEffect(() => {
    if (!activeContainer) return;
    containerViewStateRef.current[activeContainer] = {
      scale,
      position: { ...position },
      rFile,
      gFile,
      bFile,
      stretch: cloneStretchValues(stretchValues),
    };
  }, [scale, position, rFile, gFile, bFile, stretchValues, activeContainer]);

  useEffect(() => {
    saveCurrentImageHistory();
  }, [
    selectedFile, viewMode, rFile, gFile, bFile, stretchValues,
    histDropdownFile, histActiveChannel, histSelectedRange,
    histSelectedChannel, showHistogram, scale, position, displayedImageUrl,
  ]);

  useEffect(() => {
    const updateMini = () => {
      if (viewerRef.current && rasterInfo?.width && rasterInfo?.height) {
        updateMiniRectFromViewer(rasterInfo.width, rasterInfo.height, viewerRef.current);
      } else if (displayedImageUrl) {
        setMiniRect({ left: 0, top: 0, width: 1, height: 1 });
      }
    };
    updateMini();
    window.addEventListener("resize", updateMini);
    return () => window.removeEventListener("resize", updateMini);
  }, [displayedImageUrl, rasterInfo?.width, rasterInfo?.height, isSwipeMode]);

  const buildSingleImageUrl = (fileKey, stretch = {}, bandOverride = null) => {
  const key = getFullKey(fileKey);
    const { filename, band: keyBand } = parseBandKey(key);
    const band = bandOverride || keyBand;

  let url = `${API}/image?filename=${encodeURIComponent(filename)}&band=${band}`;

  if (stretch.min !== "" && stretch.min != null) {
    url += `&min_val=${encodeURIComponent(stretch.min)}`;
  }
  if (stretch.max !== "" && stretch.max != null) {
    url += `&max_val=${encodeURIComponent(stretch.max)}`;
  }
  return url;
};

// ========== PIXEL VALUE + COORDINATES ==========
useEffect(() => {
  if (isSwipeMode || !osdReady) {
    setMouseInfo(null);
    return;
  }

  const surface = osdContainerRef.current;
  if (!surface || !viewerRef.current) return;

  const handleMouseMove = (e) => {
    const viewer = viewerRef.current;
    if (!viewer?.viewport) return;

    const rect = surface.getBoundingClientRect();
    const pixel = new OpenSeadragon.Point(
      e.clientX - rect.left,
      e.clientY - rect.top
    );

    // Convert to image coordinates
    const imagePoint = viewer.viewport.viewerElementToImageCoordinates(pixel);
    const imgX = Math.round(imagePoint.x);
    const imgY = Math.round(imagePoint.y);

    // Debounce the API call
    if (mouseInfoTimeoutRef.current) {
      clearTimeout(mouseInfoTimeoutRef.current);
    }

    mouseInfoTimeoutRef.current = setTimeout(async () => {
      // Decide which file + band to query
      let fileKey = selectedFile || rFile || activeFilesPool[0];
      if (!fileKey) return;

      const { filename, band: fileBand } = parseBandKey(fileKey);
      const band = viewMode === "raster" && fileKey === selectedFile ? selectedRasterBand : fileBand;

      try {
        const res = await axios.get(`${API}/pixel-value`, {
          params: { filename, x: imgX, y: imgY, band },
          timeout: 2000,
        });
        setMouseInfo(res.data);
      } catch (err) {
        // silent fail
      }
    }, 80); // small debounce
  };

  const handleMouseLeave = () => {
    setMouseInfo(null);
    if (mouseInfoTimeoutRef.current) {
      clearTimeout(mouseInfoTimeoutRef.current);
    }
  };

  surface.addEventListener("mousemove", handleMouseMove);
  surface.addEventListener("mouseleave", handleMouseLeave);

  return () => {
    surface.removeEventListener("mousemove", handleMouseMove);
    surface.removeEventListener("mouseleave", handleMouseLeave);
    if (mouseInfoTimeoutRef.current) {
      clearTimeout(mouseInfoTimeoutRef.current);
    }
  };
}, [isSwipeMode, osdReady, selectedFile, selectedRasterBand, viewMode, rFile, activeFilesPool]);

  const buildCompositeUrl = (r, g, b, stretch, bands = rgbBandValues) => {
    let url = `${API}/rgb-composite?r_file=${encodeURIComponent(r)}&g_file=${encodeURIComponent(g)}&b_file=${encodeURIComponent(b)}&r_band=${bands.r}&g_band=${bands.g}&b_band=${bands.b}`;
    ["r", "g", "b"].forEach((ch) => {
      const s = stretch && stretch[ch];
      if (s && s.min !== "" && s.min != null) url += `&${ch}_min=${encodeURIComponent(s.min)}`;
      if (s && s.max !== "" && s.max != null) url += `&${ch}_max=${encodeURIComponent(s.max)}`;
    });
    return url;
  };

  const getHistogramPercentileValue = (data, percentile) => {
    if (!data || !data.counts || data.counts.length === 0) return null;
    const total = data.counts.reduce((a, b) => a + b, 0);
    if (total === 0) return null;
    const target = total * (percentile / 100);
    const binWidth = (data.max - data.min) / data.counts.length;
    let cumulative = 0;
    for (let i = 0; i < data.counts.length; i++) {
      cumulative += data.counts[i];
      if (cumulative >= target) return Number((data.min + i * binWidth).toFixed(3));
    }
    return data.max;
  };

  const updateStretchInput = (channel, field, value) => {
    setStretchValues((prev) => ({ ...prev, [channel]: { ...prev[channel], [field]: value } }));
  };

  const applyStretchWithValues = (channel, minVal, maxVal) => {
  const nextStretch = { ...stretchValues, [channel]: { min: minVal, max: maxVal } };
  setStretchValues(nextStretch);

  if (activeContainer) {
    containerStretchRef.current[activeContainer] = cloneStretchValues(nextStretch);
  }

  // Save current viewport before reloading
  let currentViewport = null;
  if (viewerRef.current?.viewport) {
    try {
      const vp = viewerRef.current.viewport;
      const center = vp.getCenter();
      currentViewport = {
        osdZoom: vp.getZoom(),
        osdCenter: { x: center.x, y: center.y },
      };
    } catch (_) {}
  }

  if (channel === "default") {
    const file = histDropdownFile || selectedFile;
    if (!file) return;
    saveFileStretch(file, "default", minVal, maxVal);
    setSelectedFile(file);
    setViewMode("raster");
    loadImage(
      buildSingleImageUrl(file, nextStretch.default, file === selectedFile ? selectedRasterBand : null),
      rasterViewKey(file),
      true,                // preserveView
      currentViewport      // keep same zoom/pan
    );
    setHistSelectedRange({ filename: file, channel: "default", min: minVal, max: maxVal });
    return;
  }

  const isRgbComposite = rFile && gFile && bFile;
  if (isRgbComposite) {
    const channelFile = channel === "r" ? rFile : channel === "g" ? gFile : bFile;
    saveFileStretch(channelFile, channel, minVal, maxVal);
    setSelectedFile(null);
    setViewMode("rgb");
    loadImage(
      buildCompositeUrl(rFile, gFile, bFile, nextStretch),
      compositeViewKey(rFile, gFile, bFile),
      true,
      currentViewport
    );
    if (channelFile) {
      setHistSelectedRange({ filename: channelFile, channel, min: minVal, max: maxVal });
    }
    return;
  }

  const targetFile = channel === "r" ? rFile : channel === "g" ? gFile : bFile;
  const fileToUse = targetFile || selectedFile;
  if (!fileToUse) return;
  saveFileStretch(fileToUse, channel, minVal, maxVal);
  setSelectedFile(fileToUse);
  setViewMode("raster");
  loadImage(
    buildSingleImageUrl(fileToUse, nextStretch[channel]),
    rasterViewKey(fileToUse),
    true,
    currentViewport
  );
  setHistSelectedRange({ filename: fileToUse, channel, min: minVal, max: maxVal });
};
  const applyStretch = (channel) => {
    const s = stretchValues[channel];
    if (!s) return;
    applyStretchWithValues(channel, s.min, s.max);
  };

  const applyAutoStretch = (channel, lowPct, highPct) => {
    const data =
      channel === "default" ? histDefaultData :
      channel === "r" ? histR :
      channel === "g" ? histG : histB;
    if (!data) {
      showToast(`No histogram data loaded yet.`, "error");
      return;
    }
    const lowVal = lowPct <= 0 ? data.min : getHistogramPercentileValue(data, lowPct);
    const highVal = highPct >= 100 ? data.max : getHistogramPercentileValue(data, highPct);
    applyStretchWithValues(channel, lowVal, highVal);
  };

  const resetStretch = (channel) => {
    const noStretch = createEmptyStretchValues();
    setStretchValues(noStretch);

    if (activeContainer) {
      containerStretchRef.current[activeContainer] = noStretch;
    }

    setShowHistogram(false);
    setHistActiveChannel(null);
    setHistSelectedRange(null);
    setHistSelectedChannel(null);
    rgbBeforeHistRef.current = null;

    // Preserve the current zoom/pan across the reload — clearing the
    // stretch should only change brightness/contrast, not reset where
    // you're looking. Every other stretch/band-change handler already
    // captures this; this one was the one place that didn't.
    let currentViewport = null;
    if (viewerRef.current?.viewport) {
      try {
        const vp = viewerRef.current.viewport;
        const center = vp.getCenter();
        currentViewport = {
          osdZoom: vp.getZoom(),
          osdCenter: { x: center.x, y: center.y },
        };
      } catch (_) {}
    }

    if (rFile && gFile && bFile) {
      setViewMode("rgb");
      setSelectedFile(null);
      loadImage(
        buildCompositeUrl(rFile, gFile, bFile, noStretch),
        compositeViewKey(rFile, gFile, bFile),
        true,
        currentViewport
      );
      return;
    }
    const fileToRestore = histDropdownFile || selectedFile || rFile || gFile || bFile;
    if (fileToRestore) {
      setSelectedFile(fileToRestore);
      setViewMode("raster");
      loadImage(
        buildSingleImageUrl(fileToRestore, noStretch.default, fileToRestore === selectedFile ? selectedRasterBand : null),
        rasterViewKey(fileToRestore),
        true,
        currentViewport
      );
    }
  };

  const applyRGBFromFiles = useCallback(
    (containerName, files) => {
      if (files.length === 0) {
        setRFile("");
        setGFile("");
        setBFile("");
        return;
      }

      const r = files[0];
      const g = files[1] || files[0];
      const b = files[2] || g;

      setRFile(r);
      setGFile(g);
      setBFile(b);

      if (r && g && b) {
        containerRgbRef.current[containerName] = { r, g, b };
      }

      if (files.length >= 1) {
        setActiveRgbContainer(containerName);
        setViewMode("rgb");
        setSelectedFile(null);
        const currentStretch = stretchValues;
        loadImage(buildCompositeUrl(r, g, b, currentStretch), compositeViewKey(r, g, b), false);
      }
    },
    [stretchValues]
  );

  const autoSelectRGBForContainer = (containerName) => {
    const files = containers[containerName] || [];
    applyRGBFromFiles(containerName, files);
  };

  const restoreContainerView = (containerName) => {
    if (!containerName) return;
    const saved = containerViewStateRef.current[containerName];
    if (saved) {
      setScale(saved.scale);
      setPosition(saved.position);
    }
  };

 const recomputeRGBAfterDelete = (containerName, deletedFilename) => {
  const remainingFiles = (containers[containerName] || []).filter(
    (f) => f !== deletedFilename
  );

  if (remainingFiles.length === 0) {
    setRFile("");
    setGFile("");
    setBFile("");
    setSelectedFile(null);
    setViewMode("");
    setDisplayedImageUrl("");
    setRasterInfo(null);
    delete containerRgbRef.current[containerName];
    delete containerStretchRef.current[containerName];
    if (viewerRef.current) {
      try { viewerRef.current.destroy(); } catch (_) {}
      viewerRef.current = null;
    }
    return;
  }

  // Keep whichever of the current R/G/B slots are still valid; only the
  // slot(s) that pointed at the deleted file get replaced with another
  // available band from the container. This avoids resetting bands the
  // user already had selected just because one other band was deleted.
  const currentAssignment = containerRgbRef.current[containerName] || { r: rFile, g: gFile, b: bFile };
  const pickReplacement = (exclude) =>
    remainingFiles.find((f) => !exclude.includes(f)) || remainingFiles[0];

  let r = currentAssignment.r && currentAssignment.r !== deletedFilename && remainingFiles.includes(currentAssignment.r)
    ? currentAssignment.r : null;
  let g = currentAssignment.g && currentAssignment.g !== deletedFilename && remainingFiles.includes(currentAssignment.g)
    ? currentAssignment.g : null;
  let b = currentAssignment.b && currentAssignment.b !== deletedFilename && remainingFiles.includes(currentAssignment.b)
    ? currentAssignment.b : null;

  if (!r) r = pickReplacement([g, b].filter(Boolean));
  if (!g) g = pickReplacement([r, b].filter(Boolean));
  if (!b) b = pickReplacement([r, g].filter(Boolean));

  setRFile(r);
  setGFile(g);
  setBFile(b);
  setSelectedFile(null);
  setViewMode("rgb");
  setRgbHistoryContext(containerName);

  containerRgbRef.current[containerName] = { r, g, b };

  // Keep the existing stretch instead of wiping it — a deletion swapping
  // one band shouldn't discard contrast stretching the user already set
  // up on the composite (stretch is only cleared via the Reset button).
  loadImage(
    buildCompositeUrl(r, g, b, stretchValues),
    compositeViewKey(r, g, b),
    true
  );

  axios
    .get(`${API}/metadata`, { params: { filename: r } })
    .then((res) => setRasterInfo(res.data))
    .catch((err) => console.error("Failed to load raster info:", err));
};

 const handleFileSelectInput = (e) => {
  const uploadedFiles = e.target.files;
  if (!uploadedFiles || uploadedFiles.length === 0) return;

  const fileArray = Array.from(uploadedFiles);
  e.target.value = ""; // reset input

  setPendingFiles(fileArray);

  const existingContainers = Object.keys(containers);

  if (existingContainers.length === 0) {
    // No containers yet → create first one
    processUploadsToContainer("Container 1", fileArray);
    return;
  }

  // Check if file with same name already exists in any container
  const firstFileName = fileArray[0].name;
  let matchedContainer = null;

  for (const [containerName, files] of Object.entries(containers)) {
    const exists = files.some((f) => getDisplayFilename(f) === firstFileName);
    if (exists) {
      matchedContainer = containerName;
      break;
    }
  }

  if (matchedContainer) {
    // Same name found → automatically use that container
    processUploadsToContainer(matchedContainer, fileArray);
  } else {
    // New file → ask user
    setShowContainerModal(true);
  }
};
  const getNextContainerName = () => {
    const names = Object.keys(containers);
    let maxNum = 0;
    names.forEach((name) => {
      const match = name.match(/^Container\s+(\d+)$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (!Number.isNaN(n) && n > maxNum) maxNum = n;
      }
    });
    return `Container ${maxNum + 1}`;
  };
const processUploadsToContainer = async (targetContainerName, filesToUpload) => {
  setShowContainerModal(false);

  for (const file of filesToUpload) {
    const storedFilePath = `${targetContainerName}/${file.name}`;
    if ((containers[targetContainerName] || []).includes(storedFilePath)) {
      showToast(`${file.name} already exists in ${targetContainerName}`, "error");
      continue;
    }

    setContainers((prev) => ({
      ...prev,
      [targetContainerName]: [...(prev[targetContainerName] || []), storedFilePath],
    }));
    setFileDisplayNames((prev) => ({ ...prev, [storedFilePath]: file.name }));
    setActiveContainer(targetContainerName);
    setActiveRgbContainer(targetContainerName);
    setSelectedFile(storedFilePath);
    setViewMode("raster");
    setIsImageLoading(true);
    uploadFinishedRef.current[storedFilePath] = false;
    // Keep the original browser File available while the background upload runs.
    // The local tile source will read only the regions OpenSeadragon requests.
    localFileRef.current[storedFilePath] = file;

    // Start the upload immediately in the background. The preview is generated
    // independently, so network transfer and local decoding can overlap.
    const uploadPromise = uploadFileChunked(file, targetContainerName, (p) => setUploadProgress(p))
      .then(async (result) => {
        uploadFinishedRef.current[storedFilePath] = true;
        delete localFileRef.current[storedFilePath];
        delete localTiffRef.current[storedFilePath];
        Object.keys(localStretchRef.current).forEach((key) => {
          if (key.startsWith(`${storedFilePath}:`)) delete localStretchRef.current[key];
        });
        setActiveContainer(targetContainerName);
        setActiveRgbContainer(targetContainerName);
        setSelectedFile(storedFilePath);
        setViewMode("raster");
        await loadImage(buildSingleImageUrl(storedFilePath, { min: "", max: "" }), rasterViewKey(storedFilePath));
        showToast(`${file.name} uploaded successfully`, "success");
        return result;
      })
      .catch((error) => {
        console.error("Background upload failed:", error);
        showToast(`Upload failed for ${file.name}. Local preview is still available.`, "error");
        return null;
      })
      .finally(() => {
        delete uploadPromiseRef.current[storedFilePath];
        setIsUploading(false);
        setUploadProgress(0);
      });

    uploadPromiseRef.current[storedFilePath] = uploadPromise;
    setIsUploading(true);
    setUploadProgress(0);

    // FIRST FOR THE USER: decode a small local preview directly from the selected
    // file. This does not require the file to reach Codespaces and can appear
    // while the background upload is still transferring the source TIFF.
    try {
      const preview = await createLocalGeoTiffPreview(file, 640);
      if (uploadFinishedRef.current[storedFilePath]) {
        URL.revokeObjectURL(preview.url);
      } else {
        // Store full object so width/height are available for tiles/OSD
        localPreviewRef.current[storedFilePath] = preview;
        localFileRef.current[storedFilePath] = file;
        currentRasterSizeRef.current = { width: preview.width, height: preview.height };
        setDisplayedImageUrl(preview.url);
        setShowOverviewInViewport(true);
        setRasterInfo({
          filename: storedFilePath,
          width: preview.width,
          height: preview.height,
          bands: preview.bands,
          dtype: "local preview",
          nodata: null,
          crs: null,
        });
        setMiniRect({ left: 0, top: 0, width: 1, height: 1 });
        setIsImageLoading(false);

        // Start OpenSeadragon against the local TIFF immediately. The upload
        // continues independently in the background and will replace this
        // source with backend tiles when it reaches 100%.
        loadImage(
          buildSingleImageUrl(storedFilePath, { min: "", max: "" }),
          rasterViewKey(storedFilePath),
          true
        );
      }
    } catch (previewError) {
      console.error("Local GeoTIFF preview failed:", previewError);
      setIsImageLoading(false);
      showToast(`Could not preview ${file.name} locally. Upload will continue.`, "error");
    }

  }
  setPendingFiles([]);
};

  const handleDeleteContainer = (containerName) => {
    if (!window.confirm(`Delete entire container "${containerName}" and all its rasters?`)) return;

    const files = containers[containerName] || [];

    Promise.all(
      files.map((f) => axios.delete(`${API}/files/${encodeURIComponent(f)}`).catch(() => {}))
    ).then(() => {
      setContainers((prev) => {
        const updated = { ...prev };
        delete updated[containerName];
        return updated;
      });

      setFileDisplayNames((prev) => {
        const updated = { ...prev };
        files.forEach((f) => delete updated[f]);
        return updated;
      });

      files.forEach((f) => {
        delete viewStateRef.current[rasterViewKey(f)];
        delete stretchStateRef.current[f];
        for (const key of Object.keys(imageHistoryRef.current)) {
          if (key.endsWith(`:${f}`)) delete imageHistoryRef.current[key];
        }
      });

      delete containerRgbRef.current[containerName];
      delete containerStretchRef.current[containerName];
      delete containerViewStateRef.current[containerName];

      if (activeContainer === containerName) {
        setActiveContainer(null);
        setActiveRgbContainer("");
        setSelectedFile(null);
        setViewMode("");
        setDisplayedImageUrl("");
        setRasterInfo(null);
      }

      showToast(`Container "${containerName}" deleted`, "success");
    });
  };

  const resetView = () => {
  const viewer = viewerRef.current;
  userHasSetViewRef.current = false;

  if (viewer?.viewport && osdReady) {
    viewer.viewport.goHome(true);          // back to 100%
    viewer.viewport.applyConstraints();
    saveCurrentImageHistory();
    return;
  }

  // Fallback if viewer is not ready
  setScale(1);
  setPosition({ x: 0, y: 0 });
};

  const handleSelectRaster = async (filename) => {
  console.log("handleSelectRaster called with:", filename);

  setIsImageLoading(true);
  setSelectedFile(filename);

  if (isSwipeMode) return;

  // Save current view before leaving
  saveCurrentImageHistory();

  const containerName = getContainerForFile(filename) || activeContainer;
  if (containerName) lastViewedFileByContainerRef.current[containerName] = filename;

  const saved = getSavedImageHistory(containerName, filename);
  setHistoryContext(containerName, filename);

  if (saved) {
    // ---------- INSTANT RESTORE ----------
    const savedBand = saved.selectedRasterBand || 1;
    selectedRasterBandRef.current = savedBand;
    setSelectedRasterBand(savedBand);
    setViewMode(saved.viewMode || (saved.rFile && saved.gFile && saved.bFile ? "rgb" : "raster"));
    setRFile(saved.rFile || "");
    setGFile(saved.gFile || "");
    setBFile(saved.bFile || "");
    const savedRgbBands = saved.rgbBandValues || { r: 1, g: 1, b: 1 };
    setRgbBandValues(savedRgbBands);
    setStretchValues(cloneStretchValues(saved.stretchValues));
    setHistDropdownFile(saved.histDropdownFile || filename);
    setHistActiveChannel(saved.histActiveChannel || null);
    setHistSelectedRange(saved.histSelectedRange || null);
    setHistSelectedChannel(saved.histSelectedChannel || null);
    setShowHistogram(Boolean(saved.showHistogram));
    setActiveContainer(containerName || "");
    setActiveRgbContainer(containerName || "");

    // 1. Show the previous overview INSTANTLY if we still have it in memory
    if (saved.displayedImageUrl) {
      setDisplayedImageUrl(saved.displayedImageUrl);
      setShowOverviewInViewport(true);
      setIsImageLoading(false);
    }

    const isSavedRgb = saved.rFile && saved.gFile && saved.bFile;

    if (isSavedRgb) {
      setSelectedFile(null);
      setViewMode("rgb");
      loadImage(
        buildCompositeUrl(saved.rFile, saved.gFile, saved.bFile, saved.stretchValues, savedRgbBands),
        compositeViewKey(saved.rFile, saved.gFile, saved.bFile),
        true,               // preserveView
        saved               // restore exact zoom + pan
      );
    } else {
      setSelectedFile(filename);
      setViewMode("raster");
      loadImage(
        buildSingleImageUrl(filename, saved.stretchValues?.default || { min: "", max: "" }, savedBand),
        rasterViewKey(filename),
        true,               // preserveView
        saved
      );
    }

    if (saved.showHistogram) {
      setHistDefaultData(null);
      fetchHistogramFor(filename, setHistDefaultLoading, setHistDefaultData);
      if (saved.rFile) fetchChannelHistogram(saved.rFile, "r");
      if (saved.gFile) fetchChannelHistogram(saved.gFile, "g");
      if (saved.bFile) fetchChannelHistogram(saved.bFile, "b");
    }
    } else {
    // First time opening this file → ALWAYS show low-res original first
    setSelectedFile(filename);
    selectedRasterBandRef.current = 1;
    setSelectedRasterBand(1);
    setViewMode("raster");
    setHistSelectedRange(null);
    setHistActiveChannel(null);
    setHistDropdownFile(filename);
    setHistDefaultData(null);
    setShowHistogram(false);

    const fullKey = getFullKey(filename);
    const localPreview = localPreviewRef.current[fullKey] || localPreviewRef.current[filename];
    let hasLocal = false;

    if (localPreview) {
      const previewUrl = typeof localPreview === "string" ? localPreview : localPreview.url;
      if (previewUrl) {
        // Show low-resolution original image IMMEDIATELY
        setDisplayedImageUrl(previewUrl);
        setShowOverviewInViewport(true);
        setIsImageLoading(false);
        hasLocal = true;
      }
      if (localPreview.width && localPreview.height) {
        currentRasterSizeRef.current = { width: localPreview.width, height: localPreview.height };
      }
    }

    const restoredStretch = getFileStretch(fullKey);
    setStretchValues(restoredStretch);
    setRFile("");
    setGFile("");
    setBFile("");
    setRgbBandValues({ r: 1, g: 1, b: 1 });
    setHistR(null);
    setHistG(null);
    setHistB(null);

    // Start tiled viewer (high-res on demand) while keeping the low-res image visible
    loadImage(
      buildSingleImageUrl(fullKey, restoredStretch.default, 1),
      rasterViewKey(fullKey),
      hasLocal          // ← keep low-res overview until first high-res tile arrives
    );
  }

  if (containerName) {
    setActiveContainer(containerName);
    setActiveRgbContainer(containerName);
  }

  // Metadata (non-blocking)
  const metadataRequestId = loadSequenceRef.current;
  try {
    const res = await axios.get(`${API}/metadata`, { params: { filename } });
    if (metadataRequestId === loadSequenceRef.current) {
      setRasterInfo(res.data);
    }
  } catch (err) {
    // ignore
  }
};

const handleRasterBandChange = (event) => {
  const band = Number(event.target.value);
  if (!bandSourceFile || !Number.isInteger(band) || band < 1) return;

  saveCurrentImageHistory();
  selectedRasterBandRef.current = band;
  setSelectedRasterBand(band);
  setSelectedFile(bandSourceFile);
  setViewMode("raster");
  setHistoryContext(getContainerForFile(bandSourceFile) || activeContainer, bandSourceFile);

  let currentViewport = null;
  if (viewerRef.current?.viewport) {
    const viewport = viewerRef.current.viewport;
    const center = viewport.getCenter();
    currentViewport = { osdZoom: viewport.getZoom(), osdCenter: { x: center.x, y: center.y } };
  }
  loadImage(
    buildSingleImageUrl(bandSourceFile, stretchValues.default, band),
    rasterViewKey(bandSourceFile),
    true,
    currentViewport
  );
};

const handleRgbBandChange = (channel, value) => {
  const bands = { ...rgbBandValues, [channel]: Number(value) };
  setRgbBandValues(bands);
  if (rFile && gFile && bFile) {
    loadImage(
      buildCompositeUrl(rFile, gFile, bFile, stretchValues, bands),
      compositeViewKey(rFile, gFile, bFile),
      true
    );
  }
};

const applySelectedRasterRgb = () => {
  const sourceFile = bandSourceFile || selectedFile || activeFilesPool[0];
  if (!sourceFile || !rasterInfo?.bands) return;
  const bands = Object.fromEntries(
    Object.entries(rgbBandValues).map(([channel, band]) => [channel, Math.min(Math.max(1, band), rasterInfo.bands)])
  );
  setRgbBandValues(bands);
  setRFile(sourceFile);
  setGFile(sourceFile);
  setBFile(sourceFile);
  setSelectedFile(null);
  setViewMode("rgb");
  if (activeContainer) setRgbHistoryContext(activeContainer);
  loadImage(
    buildCompositeUrl(sourceFile, sourceFile, sourceFile, stretchValues, bands),
    compositeViewKey(sourceFile, sourceFile, sourceFile)
  );
};

  const handleDeleteRaster = async (e, filename) => {
  e.stopPropagation();
  const displayName = getDisplayName(filename);
  if (!window.confirm(`Delete ${displayName}?`)) return;

  const containerName = getContainerForFile(filename) || activeContainer;
  const wasSelected = selectedFile === filename;
  const wasInRGB = rFile === filename || gFile === filename || bFile === filename;
  const isCurrentlyViewed =
    wasSelected ||
    (viewMode === "rgb" && (rFile === filename || gFile === filename || bFile === filename)) ||
    (viewMode === "swipe" && (swipeLeftFile === filename || swipeRightFile === filename));

  try {
    await axios.delete(`${API}/files/${encodeURIComponent(filename)}`);

    // 1. Remove from containers state
    setContainers((prev) => {
      const updated = {};
      for (const [cName, list] of Object.entries(prev)) {
        const filtered = list.filter((f) => f !== filename);
        if (filtered.length > 0) updated[cName] = filtered;
      }
      return updated;
    });

    // 2. Clean up caches & state
    setFileDisplayNames((prev) => {
      const updated = { ...prev };
      delete updated[filename];
      return updated;
    });

    delete viewStateRef.current[rasterViewKey(filename)];
    delete stretchStateRef.current[filename];
    delete metadataCacheRef.current[filename];
    if (localPreviewRef.current[filename]) {
      try { URL.revokeObjectURL(localPreviewRef.current[filename]); } catch (_) {}
      delete localPreviewRef.current[filename];
    }
    delete localFileRef.current[filename];
    delete localTiffRef.current[filename];
    Object.keys(localStretchRef.current).forEach((key) => {
      if (key.startsWith(`${filename}:`)) delete localStretchRef.current[key];
    });
    delete uploadPromiseRef.current[filename];
    delete uploadFinishedRef.current[filename];
    for (const key of Object.keys(imageHistoryRef.current)) {
      if (key.endsWith(`:${filename}`)) delete imageHistoryRef.current[key];
    }

    if (swipeLeftFile === filename) setSwipeLeftFile("");
    if (swipeRightFile === filename) setSwipeRightFile("");

    // 3. Smart viewport recovery
    if (isCurrentlyViewed && containerName) {
      const remainingFiles = (containers[containerName] || []).filter(
        (f) => f !== filename
      );

      if (remainingFiles.length === 0) {
        // Container is now empty → clear viewport cleanly
        setSelectedFile(null);
        setViewMode("");
        setDisplayedImageUrl("");
        setRasterInfo(null);
        setRFile("");
        setGFile("");
        setBFile("");
        setActiveContainer(null);
        setActiveRgbContainer("");
        if (viewerRef.current) {
          try { viewerRef.current.destroy(); } catch (_) {}
          viewerRef.current = null;
        }
      } else {
        // Automatically switch to another file in the same container
        const nextFile = remainingFiles[0];

        // Prefer keeping RGB if possible
        if (wasInRGB && remainingFiles.length >= 1) {
          recomputeRGBAfterDelete(containerName, filename);
        } else {
          // Switch to single-band view of the next available file
          setTimeout(() => {
            handleSelectRaster(nextFile);
          }, 50);
        }
      }
    } else if (wasInRGB) {
      // File was part of RGB but not the main selected one
      recomputeRGBAfterDelete(containerName, filename);
    }

    showToast(`${displayName} deleted`, "success");
  } catch (err) {
    console.error("Delete failed:", err);
    showToast(`Failed to delete ${displayName}`, "error");
  }
};

  const handleDownload = async () => {
    if (!displayedImageUrl && !isSwipeMode) return;
    if (isSwipeMode) {
      showToast("Download not supported in swipe mode. Switch to standard view.", "error");
      return;
    }
    try {
      const res = await fetch(displayedImageUrl);
      const blob = await res.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const rawName = getDisplayName(selectedFile) || viewMode || "raster";
      const baseName = rawName.replace(/\.(tif|tiff)$/i, "");
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${baseName}-${viewMode || "view"}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(objectUrl);
    } catch (err) {
      showToast("Download failed.", "error");
    }
  };

const fetchHistogramFor = async (fileKey, setLoading, setData) => {
  if (!fileKey) return;
  const { filename, band } = parseBandKey(fileKey);
  setLoading(true);
  try {
    const res = await axios.get(`${API}/histogram`, {
      params: { filename, band, bins: 32 },
    });
    setData(res.data);
  } catch (err) {
    console.error("Histogram error:", err);
    showToast("Failed to fetch histogram data.", "error");
  } finally {
    setLoading(false);
  }
};
  const fetchChannelHistogram = (filename, channel) => {
    const setLoading =
      channel === "r" ? setHistRLoading :
      channel === "g" ? setHistGLoading : setHistBLoading;
    const setData =
      channel === "r" ? setHistR :
      channel === "g" ? setHistG : setHistB;
    fetchHistogramFor(filename, setLoading, setData);
  };
  
const handleRGBChange = (channel, value) => {
  if (isSwipeMode) return;
  saveCurrentImageHistory();

  // Save current zoom & pan before changing
  let currentViewport = null;
  if (viewerRef.current?.viewport) {
    try {
      const vp = viewerRef.current.viewport;
      const center = vp.getCenter();
      currentViewport = {
        osdZoom: vp.getZoom(),
        osdCenter: { x: center.x, y: center.y },
      };
    } catch (_) {}
  }

  // Update the selected channel
  let nextR = rFile, nextG = gFile, nextB = bFile;
  if (channel === "r") { nextR = value; setRFile(value); }
  if (channel === "g") { nextG = value; setGFile(value); }
  if (channel === "b") { nextB = value; setBFile(value); }
  const nextBands = { ...rgbBandValues, [channel]: 1 };
  setRgbBandValues(nextBands);

  if (activeContainer) {
    containerRgbRef.current[activeContainer] = { r: nextR, g: nextG, b: nextB };
  }

  // Only load when all three channels are selected
  if (nextR && nextG && nextB) {
    setSelectedFile(null);
    setViewMode("rgb");
    if (activeContainer) setRgbHistoryContext(activeContainer);

    // Keep current stretch values
    const currentStretch = stretchValues;

    loadImage(
      buildCompositeUrl(nextR, nextG, nextB, currentStretch, nextBands),
      compositeViewKey(nextR, nextG, nextB),
      true,                 // preserve view
      currentViewport       // keep same zoom + pan
    );
  }
};

  const selectHistChannel = (channel) => {
  saveCurrentImageHistory();

  const file = channel === "r" ? rFile : channel === "g" ? gFile : bFile;
  if (!file) {
    showToast(`Select a file for the ${channel.toUpperCase()} channel first.`, "error");
    return;
  }

  // Save current zoom & pan
  let currentViewport = null;
  if (viewerRef.current?.viewport) {
    try {
      const vp = viewerRef.current.viewport;
      const center = vp.getCenter();
      currentViewport = {
        osdZoom: vp.getZoom(),
        osdCenter: { x: center.x, y: center.y },
      };
    } catch (_) {}
  }

  setHistActiveChannel(channel);
  fetchChannelHistogram(file, channel);

  const isRgbComposite = rFile && gFile && bFile;

  if (isRgbComposite) {
    setSelectedFile(null);
    setViewMode("rgb");
    loadImage(
      buildCompositeUrl(rFile, gFile, bFile, stretchValues),
      compositeViewKey(rFile, gFile, bFile),
      true,                 // preserve view
      currentViewport       // keep same zoom + pan
    );
  } else {
    setSelectedFile(file);
    setViewMode("raster");
    loadImage(
      buildSingleImageUrl(file, stretchValues[channel]),
      rasterViewKey(file),
      true,
      currentViewport
    );
  }
};

  const toggleSwipeMode = () => {
    if (isSwipeMode) {
      const previousView = viewBeforeSwipeRef.current;
      setIsSwipeMode(false);
      setIsProfileMode(false);
      if (previousView?.viewMode === "rgb" && previousView.rFile && previousView.gFile && previousView.bFile) {
        setRFile(previousView.rFile);
        setGFile(previousView.gFile);
        setBFile(previousView.bFile);
        setSelectedFile(null);
        setViewMode("rgb");
        setStretchValues(previousView.stretchValues);
        loadImage(
          buildCompositeUrl(previousView.rFile, previousView.gFile, previousView.bFile, previousView.stretchValues),
          compositeViewKey(previousView.rFile, previousView.gFile, previousView.bFile)
        );
      } else if (previousView?.selectedFile) {
        setSelectedFile(previousView.selectedFile);
        selectedRasterBandRef.current = previousView.selectedRasterBand || 1;
        setSelectedRasterBand(previousView.selectedRasterBand || 1);
        setViewMode("raster");
        setStretchValues(previousView.stretchValues);
        loadImage(
          buildSingleImageUrl(previousView.selectedFile, previousView.stretchValues.default, previousView.selectedRasterBand || 1),
          rasterViewKey(previousView.selectedFile)
        );
      } else if (previousView?.displayedImageUrl) {
        setDisplayedImageUrl(previousView.displayedImageUrl);
        setViewMode(previousView.viewMode || "raster");
      }
      showToast("Exited Swipe Compare mode", "success");
      return;
    }
    if (activeFilesPool.length < 2) {
      showToast("Need at least 2 rasters in active container for swipe.", "error");
      return;
    }
    viewBeforeSwipeRef.current = {
      selectedFile, selectedRasterBand, viewMode, rFile, gFile, bFile,
      stretchValues: cloneStretchValues(stretchValues),
      displayedImageUrl,
    };
    setIsSwipeMode(true);
    setIsProfileMode(false);
    setSelectedFile(null);
    setViewMode("swipe");
    setSwipeLeftFile(activeFilesPool[0]);
    setSwipeRightFile(activeFilesPool[1] || activeFilesPool[0]);
    setSwipeLeftLoading(true);
    setSwipeRightLoading(true);
    setSwipePosition(50);
    showToast("Swipe Compare mode activated", "success");
  };

  useEffect(() => {
    const handleWindowPointerMove = (e) => {
      if (!isDraggingSwipeDivider || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
      setSwipePosition(percentage);
    };
    const handleWindowPointerUp = () => setIsDraggingSwipeDivider(false);
    if (isDraggingSwipeDivider) {
      window.addEventListener("pointermove", handleWindowPointerMove);
      window.addEventListener("pointerup", handleWindowPointerUp);
    }
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
    };
  }, [isDraggingSwipeDivider]);

  useEffect(() => {
    const handleFallbackDrag = (e) => {
      const drag = fallbackDragRef.current;
      if (!drag.active) return;
      setPosition({
        x: drag.originX + e.clientX - drag.startX,
        y: drag.originY + e.clientY - drag.startY,
      });
    };
    const finishFallbackDrag = () => {
      if (!fallbackDragRef.current.active) return;
      fallbackDragRef.current.active = false;
      saveCurrentImageHistory();
    };

    window.addEventListener("pointermove", handleFallbackDrag);
    window.addEventListener("pointerup", finishFallbackDrag);
    return () => {
      window.removeEventListener("pointermove", handleFallbackDrag);
      window.removeEventListener("pointerup", finishFallbackDrag);
    };
  }, []);

  useEffect(() => {
    if (!histBoxDrag) return;
    const handleMove = (e) => {
      const clampedX = Math.max(0, Math.min(histBoxDrag.rectWidth, e.clientX - histBoxDrag.rectLeft));
      setHistBoxDrag({ ...histBoxDrag, currentX: clampedX });
    };
    const handleUp = () => {
      const { channel, file, startX, currentX, rectWidth } = histBoxDrag;
      const data =
        channel === "default" ? histDefaultData :
        channel === "r" ? histR :
        channel === "g" ? histG : histB;
      const leftPx = Math.min(startX, currentX);
      const rightPx = Math.max(startX, currentX);
      if (data && file && rectWidth > 0 && rightPx - leftPx > 2) {
        const range = data.max - data.min;
        const rangeMin = Number((data.min + (leftPx / rectWidth) * range).toFixed(3));
        const rangeMax = Number((data.min + (rightPx / rectWidth) * range).toFixed(3));
        setHistSelectedRange({ filename: file, channel, min: rangeMin, max: rangeMax });
        setHistSelectedChannel(channel);
        applyStretchWithValues(channel, rangeMin, rangeMax);
      }
      setHistBoxDrag(null);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [histBoxDrag, histR, histG, histB, histDefaultData]);

  const fetchRoiAnalysis = useCallback(async (selection) => {
    if (!selection?.filename) return;
    const key = selection.filename.includes("/") || !activeContainer
      ? selection.filename
      : `${activeContainer}/${selection.filename}`;
    const filename = key.includes("::band") ? key.split("::band")[0] : key;
    setIsRoiLoading(true);
    setRoiAnalysis(null);
    setRoiAiAnalysis("");
    try {
      const res = await axios.post(`${API}/roi-analysis`, {
        filename,
        x: selection.x,
        y: selection.y,
        width: selection.width,
        height: selection.height,
      });
      setRoiAnalysis(res.data);
      setSelectedRoiBand(1);
    } catch (err) {
      console.error("ROI analysis error:", err);
      const message = err.response?.data?.detail || "Failed to analyze the selected ROI.";
      setToast({ message, type: "error" });
      window.setTimeout(() => setToast(null), 3500);
    } finally {
      setIsRoiLoading(false);
    }
  }, [activeContainer]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
      if (activeObjectUrlRef.current) URL.revokeObjectURL(activeObjectUrlRef.current);
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setRoiSelection(null);
    setRoiDraft(null);
    setRoiScreenRect(null);
    setRoiAnalysis(null);
    setRoiAiAnalysis("");
  }, [roiSourceFile]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const surface = osdContainerRef.current;
    if (!viewer || !surface || !osdReady || isSwipeMode) return;

    viewer.setMouseNavEnabled(!isRoiDrawing);
    surface.style.cursor = isRoiDrawing ? "crosshair" : "grab";
    if (!isRoiDrawing) return;

    const getImagePoint = (event) => {
      const bounds = currentRasterSizeRef.current;
      const rect = surface.getBoundingClientRect();
      const localPoint = new OpenSeadragon.Point(event.clientX - rect.left, event.clientY - rect.top);
      const imagePoint = viewer.viewport.viewerElementToImageCoordinates(localPoint);
      return {
        x: Math.max(0, Math.min(bounds.width, imagePoint.x)),
        y: Math.max(0, Math.min(bounds.height, imagePoint.y)),
      };
    };

    const drawDraft = (point) => {
      const start = roiDragRef.current.start;
      if (!start) return;
      const rect = {
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      };
      setRoiDraft(rect);
      const topLeft = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(rect.x, rect.y));
      const bottomRight = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(rect.x + rect.width, rect.y + rect.height));
      setRoiScreenRect({ left: topLeft.x, top: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y });
    };

    const handlePointerDown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const point = getImagePoint(event);
      roiDragRef.current = { start: point, pointerId: event.pointerId };
      surface.setPointerCapture?.(event.pointerId);
      drawDraft(point);
    };
    const handlePointerMove = (event) => {
      if (roiDragRef.current.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      drawDraft(getImagePoint(event));
    };
    const handlePointerUp = (event) => {
      if (roiDragRef.current.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const start = roiDragRef.current.start;
      const point = getImagePoint(event);
      roiDragRef.current = { start: null, pointerId: null };
      surface.releasePointerCapture?.(event.pointerId);
      setRoiDraft(null);
      setIsRoiDrawing(false);

      const bounds = currentRasterSizeRef.current;
      const x = Math.max(0, Math.floor(Math.min(start.x, point.x)));
      const y = Math.max(0, Math.floor(Math.min(start.y, point.y)));
      const right = Math.min(bounds.width, Math.ceil(Math.max(start.x, point.x)));
      const bottom = Math.min(bounds.height, Math.ceil(Math.max(start.y, point.y)));
      if (right <= x || bottom <= y || !roiSourceFile) {
        setRoiScreenRect(null);
        showToast("Drag across the image to select an ROI.", "error");
        return;
      }

      const selection = { filename: roiSourceFile, x, y, width: right - x, height: bottom - y };
      setRoiSelection(selection);
      setShowRoiPanel(true);
      setRoiAiAnalysis("");
      const topLeft = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(x, y));
      const bottomRight = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(right, bottom));
      setRoiScreenRect({ left: topLeft.x, top: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y });
      fetchRoiAnalysis(selection);
    };
    const handlePointerCancel = () => {
      roiDragRef.current = { start: null, pointerId: null };
      setRoiDraft(null);
      setRoiScreenRect(null);
      setIsRoiDrawing(false);
    };

    surface.addEventListener("pointerdown", handlePointerDown, true);
    surface.addEventListener("pointermove", handlePointerMove, true);
    surface.addEventListener("pointerup", handlePointerUp, true);
    surface.addEventListener("pointercancel", handlePointerCancel, true);
    return () => {
      surface.removeEventListener("pointerdown", handlePointerDown, true);
      surface.removeEventListener("pointermove", handlePointerMove, true);
      surface.removeEventListener("pointerup", handlePointerUp, true);
      surface.removeEventListener("pointercancel", handlePointerCancel, true);
      if (viewerRef.current === viewer) viewer.setMouseNavEnabled(true);
      surface.style.cursor = "grab";
    };
  }, [isRoiDrawing, isSwipeMode, osdReady, roiSourceFile, fetchRoiAnalysis]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !osdReady) return;
    const updateOverlay = () => {
      const rect = roiDraft || roiSelection;
      if (!rect) {
        setRoiScreenRect(null);
        return;
      }
      const topLeft = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(rect.x, rect.y));
      const bottomRight = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(rect.x + rect.width, rect.y + rect.height));
      setRoiScreenRect({ left: topLeft.x, top: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y });
    };
    viewer.addHandler("viewport-change", updateOverlay);
    viewer.addHandler("animation-finish", updateOverlay);
    updateOverlay();
    return () => {
      viewer.removeHandler("viewport-change", updateOverlay);
      viewer.removeHandler("animation-finish", updateOverlay);
    };
  }, [osdReady, roiDraft, roiSelection]);

  useEffect(() => {
  if (!isProfileMode || isSwipeMode) return;

  const surface = osdContainerRef.current;
  if (!surface || !viewerRef.current) return;

  const handleClick = (e) => {
    const viewer = viewerRef.current;
    if (!viewer?.viewport) return;

    const rect = surface.getBoundingClientRect();
    const pixel = new OpenSeadragon.Point(
      e.clientX - rect.left,
      e.clientY - rect.top
    );

    const imagePoint = viewer.viewport.viewerElementToImageCoordinates(pixel);
    const point = {
      x: Math.round(imagePoint.x),
      y: Math.round(imagePoint.y),
    };

    if (!profileStart) {
      setProfileStart(point);
      showToast("Start point set. Now click the end point.", "success");
    } else {
      setProfileEnd(point);
      setIsProfileMode(false);

      const fileToUse = profileFile || selectedFile || rFile || (activeFilesPool[0] || "");
      if (fileToUse) {
        fetchProfilePlot(profileStart, point, fileToUse, selectedProfileBand);
      } else {
        showToast("No file selected for profile.", "error");
      }
    }
  };

  surface.style.cursor = "crosshair";
  surface.addEventListener("click", handleClick);

  return () => {
    surface.removeEventListener("click", handleClick);
    surface.style.cursor = "grab";
  };
}, [isProfileMode, profileStart, profileFile, selectedFile, rFile, activeFilesPool, selectedProfileBand]);

  const openHistogramModal = () => {
    if (activeFilesPool.length === 0 && allFilesList.length === 0) {
      return showToast("No files in active container. Select a container first.", "error");
    }

    saveCurrentImageHistory();

    if (viewMode === "rgb" && rFile && gFile && bFile) {
      rgbBeforeHistRef.current = {
        r: rFile,
        g: gFile,
        b: bFile,
        stretch: cloneStretchValues(stretchValues),
      };
    } else {
      rgbBeforeHistRef.current = null;
    }

    const defaultFile =
      (selectedFile && activeFilesPool.includes(selectedFile)) ? selectedFile : activeFilesPool[0];
    if (!defaultFile) return;

    setHistDropdownFile(histDropdownFile || defaultFile);
    setHistActiveChannel(histActiveChannel || null);
    setHistDefaultData(null);
    fetchHistogramFor(histDropdownFile || defaultFile, setHistDefaultLoading, setHistDefaultData);

    setShowHistogram(true);
    setShowScatterPlot(false);
    setShowProfileModal(false);
    setShowRoiPanel(false);
    setIsProfileMode(false);
  };

  const closeHistogramAndRestore = () => {
    saveCurrentImageHistory();

    setShowHistogram(false);
    setHistActiveChannel(null);
    setHistSelectedRange(null);
    setHistSelectedChannel(null);
  };

  const openScatterPlotModal = () => {
    if (activeFilesPool.length === 0) {
      return showToast("No files in active container. Select a container first.", "error");
    }

    let defaultXFile = rFile || activeFilesPool[0];
    let defaultYFile = gFile || rFile || activeFilesPool[0];

    if (!defaultXFile) defaultXFile = activeFilesPool[0];
    if (!defaultYFile) defaultYFile = defaultXFile;

    setScatterXFile(defaultXFile);
    setScatterYFile(defaultYFile);
    setScatterXBand(1);
    setScatterYBand(1);
    setScatterError("");
    setScatterData(null);

    setShowHistogram(false);
    setShowScatterPlot(true);
    setShowProfileModal(false);
    setShowRoiPanel(false);
    setIsProfileMode(false);

    fetchScatterPlotData(defaultXFile, 1, defaultYFile, 1);
  };

  const fetchScatterPlotData = async (xFile, xBand, yFile, yBand) => {
    if (!xFile || !yFile) return;
    const xFilename = parseBandKey(getFullKey(xFile)).filename;
    const yFilename = parseBandKey(getFullKey(yFile)).filename;
    const requestId = ++scatterRequestRef.current;
    setIsScatterLoading(true);
    setScatterError("");
    setScatterData(null);
    try {
      const res = await axios.get(`${API}/scatter-plot`, {
        params: { filename: xFilename, x_band: xBand, y_file: yFilename, y_band: yBand },
      });
      if (requestId === scatterRequestRef.current) setScatterData(res.data);
    } catch (err) {
      console.error("Scatter plot error:", err);
      if (requestId === scatterRequestRef.current) {
        setScatterError(err.response?.data?.detail || "Could not calculate this band comparison.");
      }
    } finally {
      if (requestId === scatterRequestRef.current) setIsScatterLoading(false);
    }
  };

  const openProfilePlotModal = () => {
  if (activeFilesPool.length === 0) {
    return showToast("No files in active container.", "error");
  }

  const defaultFile = selectedFile || rFile || activeFilesPool[0];
  setProfileFile(defaultFile);
  setSelectedProfileBand(1);
  setProfileStart(null);
  setProfileEnd(null);
  setProfileData(null);
  setProfileError("");

  setShowHistogram(false);
  setShowScatterPlot(false);
  setShowProfileModal(false);
  setShowRoiPanel(false);
  setIsProfileMode(true);
  setShowProfileModal(true);

  showToast("Click two points on the image to draw the profile line.", "success");
};

  const fetchProfilePlot = async (pStart, pEnd, filename, band = 1) => {
    if (!filename || !pStart || !pEnd) return;
    const sourceFilename = parseBandKey(getFullKey(filename)).filename;
    setIsProfileLoading(true);
    setProfileError("");
    setShowProfileModal(true);
    try {
      const res = await axios.get(`${API}/profile-plot`, {
        params: { filename: sourceFilename, x0: pStart.x, y0: pStart.y, x1: pEnd.x, y1: pEnd.y, band },
      });
      setProfileData(res.data);
    } catch (err) {
      console.error("Profile plot error:", err);
      setProfileError(err.response?.data?.detail || "Could not sample the selected profile line.");
      showToast("Failed to fetch profile data.", "error");
    } finally {
      setIsProfileLoading(false);
    }
  };

  const analyzeRoiWithAi = async () => {
    if (!roiAnalysis) return;
    setIsRoiAiLoading(true);
    setRoiAiAnalysis("");
    try {
      const res = await axios.post(`${API}/roi-ai-analysis`, roiAnalysis);
      setRoiAiAnalysis(res.data.analysis || "No AI analysis was returned.");
    } catch (err) {
      const message = err.response?.data?.detail || "AI analysis failed.";
      setRoiAiAnalysis(message);
    } finally {
      setIsRoiAiLoading(false);
    }
  };

  const handleZoomIn = () => {
    const viewer = viewerRef.current;
    userHasSetViewRef.current = true;
    if (viewer?.viewport && osdReady) {
      viewer.viewport.zoomBy(1.2, viewer.viewport.getCenter(), true);
      viewer.viewport.applyConstraints();
    } else {
      setScale((currentScale) => Math.min(8, currentScale * 1.2));
    }
    saveCurrentImageHistory();
  };

  const handleZoomOut = () => {
    const viewer = viewerRef.current;
    userHasSetViewRef.current = true;
    if (viewer?.viewport && osdReady) {
      viewer.viewport.zoomBy(1 / 1.2, viewer.viewport.getCenter(), true);
      viewer.viewport.applyConstraints();
    } else {
      setScale((currentScale) => Math.max(1, currentScale / 1.2));
    }
    saveCurrentImageHistory();
  };

  const getImageStyle = useMemo(
    () => ({
      ...styles.rasterImageStyle,
      transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
      imageRendering: "auto",
      WebkitImageRendering: "auto",
      msInterpolationMode: "bicubic",
    }),
    [position, scale]
  );

  const renderHistogramBlock = (channelKey, color, label, file, data, loading) => {
    if (loading) return <div className="histogram-loading"><span className="histogram-spinner" />Loading histogram data</div>;
    if (!data) return <div className="histogram-empty">No histogram data for {label}.</div>;
    const stretch = stretchValues[channelKey] || { min: "", max: "" };
    const countMax = Math.max(1, ...data.counts);
    const sampleCount = data.counts.reduce((sum, count) => sum + count, 0);
    const valueRange = data.max - data.min || 1;
    const meanPosition = Math.max(0, Math.min(100, ((data.mean - data.min) / valueRange) * 100));

    return (
      <div className="histogram-card">
        <div className="histogram-card-header">
          <div style={{ minWidth: 0 }}>
            <div className="histogram-kicker">{channelKey === "default" ? "RASTER BAND" : "RGB CHANNEL"}</div>
            <div className="histogram-series-name">{label}</div>
            <div className="histogram-source" title={getDisplayName(file)}>{getDisplayName(file)}</div>
          </div>
          <span className="histogram-swatch" style={{ background: color }} />
        </div>
        <div className="histogram-summary">
          <div><span>Samples</span><strong>{sampleCount.toLocaleString()}</strong></div>
          <div><span>Mean</span><strong>{data.mean.toFixed(2)}</strong></div>
          <div><span>Std dev</span><strong>{data.std.toFixed(2)}</strong></div>
        </div>
        <div
          className="histogram-plot"
          style={{ "--histogram-color": color, userSelect: "none" }}
          onMouseDown={(e) => {
            if (!file) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            const startX = e.clientX - rect.left;
            setHistBoxDrag({ channel: channelKey, file, rectLeft: rect.left, rectWidth: rect.width, startX, currentX: startX });
          }}
        >
          <div className="histogram-bars" style={{ cursor: file ? "crosshair" : "default" }}>
            {data.counts.map((count, idx) => {
              const pct = Math.max((count / countMax) * 100, 1.5);
              return (
                <div key={idx} title={`Bin ${idx + 1}: ${count.toLocaleString()} pixels`} className="histogram-bar-column">
                  <div className="histogram-bar" style={{ height: `${pct}%` }} />
                </div>
              );
            })}
            <div className="histogram-mean-marker" style={{ left: `${meanPosition}%` }} title={`Mean: ${data.mean.toFixed(2)}`} />
          </div>
          {(() => {
            const range = data.max - data.min || 1;
            let leftPct = null;
            let widthPct = null;
            if (histBoxDrag && histBoxDrag.channel === channelKey && histBoxDrag.file === file && histBoxDrag.rectWidth > 0) {
              const leftPx = Math.min(histBoxDrag.startX, histBoxDrag.currentX);
              const rightPx = Math.max(histBoxDrag.startX, histBoxDrag.currentX);
              leftPct = (leftPx / histBoxDrag.rectWidth) * 100;
              widthPct = ((rightPx - leftPx) / histBoxDrag.rectWidth) * 100;
            } else if (histSelectedRange && histSelectedRange.filename === file && histSelectedRange.channel === channelKey) {
              leftPct = ((histSelectedRange.min - data.min) / range) * 100;
              widthPct = ((histSelectedRange.max - histSelectedRange.min) / range) * 100;
            }
            if (leftPct === null) return null;
            return (
              <div
                style={{
                  position: "absolute", top: "10px", bottom: "22px",
                  left: `${Math.max(0, Math.min(100, leftPct))}%`,
                  width: `${Math.max(0.5, Math.min(100 - Math.max(0, leftPct), widthPct))}%`,
                  background: "rgba(241, 196, 95, 0.12)",
                  borderLeft: "1px solid #f1c45f",
                  borderRight: "1px solid #f1c45f",
                  pointerEvents: "none",
                }}
              />
            );
          })()}
        </div>
        <div className="histogram-axis">
          <span>{data.min.toPrecision(5)}</span><span>{(data.min + valueRange / 2).toPrecision(5)}</span><span>{data.max.toPrecision(5)}</span>
        </div>
        <div className="histogram-stretch-panel">
          <div className="histogram-stretch-heading">Linear contrast stretch</div>
          <div className="histogram-stretch-fields">
            <label><span>Minimum</span><input type="number" placeholder={data.min.toPrecision(5)} value={stretch.min} onChange={(e) => updateStretchInput(channelKey, "min", e.target.value)} /></label>
            <label><span>Maximum</span><input type="number" placeholder={data.max.toPrecision(5)} value={stretch.max} onChange={(e) => updateStretchInput(channelKey, "max", e.target.value)} /></label>
          </div>
          <div className="histogram-stretch-actions">
            <button onClick={() => applyAutoStretch(channelKey, 2, 98)} title="Auto 2–98%">Auto 2–98%</button>
            <button onClick={() => applyAutoStretch(channelKey, 0, 100)} title="Min–Max">Min–Max</button>
            <button className="histogram-apply-stretch" onClick={() => applyStretch(channelKey)}>Apply</button>
            <button className="histogram-reset-stretch" onClick={() => resetStretch(channelKey)} title="Remove stretch">Reset</button>
          </div>
          {(stretch.min !== "" || stretch.max !== "") && (
            <div style={{ fontSize: "10px", color: "#38bdf8", marginTop: "6px" }}>
              Stretching {stretch.min !== "" ? stretch.min : data.min.toFixed(1)} → {stretch.max !== "" ? stretch.max : data.max.toFixed(1)}
            </div>
          )}

          {(stretch.min !== "" || stretch.max !== "") && (
            <div
              style={{
                marginTop: "12px",
                padding: "8px",
                background: "#0b0d11",
                borderRadius: "5px",
                border: "1px solid #1e222d",
              }}
            >
              <div
                style={{
                  fontSize: "10px",
                  color: "#94a3b8",
                  marginBottom: "6px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.03em",
                }}
              >
                Stretched Histogram ({channelKey === "default" ? "Image" : channelKey.toUpperCase()})
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  height: "60px",
                  gap: "2px",
                  borderBottom: "1px solid #2a2d34",
                  paddingBottom: "2px",
                  marginBottom: "6px",
                }}
              >
                {data.counts.map((count, idx) => {
                  const max = Math.max(...data.counts, 1);
                  const pct = Math.max(Math.round((count / max) * 100), 2);
                  const binCount = data.counts.length;
                  const binWidth = (data.max - data.min) / binCount;
                  const binMin = data.min + idx * binWidth;
                  const binMax = idx === binCount - 1 ? data.max : data.min + (idx + 1) * binWidth;

                  const sMin = stretch.min !== "" ? Number(stretch.min) : data.min;
                  const sMax = stretch.max !== "" ? Number(stretch.max) : data.max;

                  const visible = binMax > sMin && binMin < sMax;
                  const opacity = visible ? 1 : 0.15;

                  return (
                    <div
                      key={`stretched-${channelKey}-${idx}`}
                      title={`Count: ${count} | ${binMin.toFixed(1)}–${binMax.toFixed(1)}`}
                      style={{
                        flex: 1,
                        height: "100%",
                        display: "flex",
                        alignItems: "flex-end",
                        pointerEvents: "none",
                      }}
                    >
                      <div
                        style={{
                          width: "100%",
                          height: `${pct}%`,
                          backgroundColor: color,
                          borderRadius: "1px 1px 0 0",
                          opacity,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, 1fr)",
                  gap: "5px",
                  fontSize: "10px",
                  color: "#94a3b8",
                  background: "#14171d",
                  padding: "6px 8px",
                  borderRadius: "4px",
                  border: "1px solid #1e222d",
                }}
              >
                <div>
                  Min:{" "}
                  {stretch.min !== "" ? Number(stretch.min).toFixed(2) : data.min.toFixed(2)}
                </div>
                <div>
                  Max:{" "}
                  {stretch.max !== "" ? Number(stretch.max).toFixed(2) : data.max.toFixed(2)}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={styles.appContainer}>
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <h2 style={styles.sidebarTitle}>GeoTIFF Studio</h2>
          <span style={styles.versionBadge}>v2.0</span>
        </div>
        <label style={styles.uploadBtn}>
          <span>📥 Import Rasters</span>
          <input type="file" multiple accept=".tif,.tiff" onChange={handleFileSelectInput} style={{ display: "none" }} />
        </label>

        <div style={styles.sectionHeader}>
          Containers & Datasets <span style={styles.badge}>{allFilesList.length}</span>
        </div>
        <div style={styles.rasterList}>
          {Object.keys(containers).length === 0 ? (
            <div style={styles.emptyStateText}>No containers or rasters loaded.</div>
          ) : (
            Object.entries(containers).map(([containerName, files]) => {
              const isContainerActive = activeContainer === containerName;
              return (
                <div
                  key={containerName}
                  style={{
                    ...styles.containerGroup,
                    borderColor: isContainerActive ? "#38bdf8" : "#1e222d",
                    background: isContainerActive ? "#0f172a" : "transparent",
                  }}
                >
                  <div
                    style={{
                      ...styles.containerHeaderBar,
                      cursor: "pointer",
                      userSelect: "none",
                    }}
            onClick={() => {
  saveCurrentImageHistory();

  setActiveContainer(containerName);
  setActiveRgbContainer(containerName);
  setHistActiveChannel(null);
  setShowHistogram(false);

  const filesInContainer = containers[containerName] || [];
  if (filesInContainer.length === 0) return;

  // ========== IMPORTANT FIX ==========
  // If the container has only 1 file → load it as a normal single image
  if (filesInContainer.length === 1) {
    handleSelectRaster(filesInContainer[0]);
    return;
  }

  // If 2 or more files → create RGB composite
  let r, g, b;

  if (filesInContainer.length === 2) {
    r = filesInContainer[0];
    g = filesInContainer[1];
    b = filesInContainer[1];
  } else {
    r = filesInContainer[0];
    g = filesInContainer[1];
    b = filesInContainer[2];
  }

  setRFile(r);
  setGFile(g);
  setBFile(b);
  setSelectedFile(null);
  setViewMode("rgb");
  setStretchValues(createEmptyStretchValues());

  containerRgbRef.current[containerName] = { r, g, b };

  loadImage(
    buildCompositeUrl(r, g, b, createEmptyStretchValues()),
    `rgb:${r}:${g}:${b}`
  );
}}
                  >
                    <span style={{ flex: 1 }}>
                      📦 {containerName} {isContainerActive && "(Active)"}
                    </span>
                    <span style={styles.badge}>{files.length}</span>
                  </div>

                  {files.map((filePath) => {
  const isSelected = selectedFile === filePath;

  return (
    <div
      key={filePath}
      onClick={(event) => {
        console.log("CLICKED:", filePath);
        setShowBandControls(false);
        const alreadyShowingRaster = viewMode === "raster" && selectedFile === filePath;
        const alreadyShowingComposite = viewMode === "rgb" && rFile === filePath && gFile === filePath && bFile === filePath;
        if (event.detail > 1 || alreadyShowingRaster || alreadyShowingComposite) return;

        // Force loading state immediately
        setIsImageLoading(true);
        setSelectedFile(filePath);
        setActiveContainer(containerName);
        setActiveRgbContainer(containerName);

        // Call the real function
        handleSelectRaster(filePath);
      }}
      onDoubleClick={() => setShowBandControls(true)}
      style={{
        padding: "10px 12px",
        marginBottom: "6px",
        borderRadius: "6px",
        border: isSelected ? "1px solid #3b82f6" : "1px solid #2a2d34",
        background: isSelected ? "#1e293b" : "#14171d",
        cursor: "pointer",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <div>
        <div style={{ fontSize: "13px", fontWeight: 600, color: "#f1f5f9" }}>
          {getDisplayName(filePath)}
        </div>
        <div style={{ fontSize: "11px", color: "#64748b" }}>
          GeoTIFF Dataset
        </div>
      </div>

      <span
        onClick={(e) => {
          e.stopPropagation();
          handleDeleteRaster(e, filePath);
        }}
        style={{ color: "#64748b", cursor: "pointer", padding: "4px" }}
      >
        ✕
      </span>
    </div>
  );
})}
                  <button
                    style={{
                      alignSelf: "flex-end",
                      background: "none",
                      border: "1px solid #efe6e6",
                      color: "#ecdada",
                      cursor: "pointer",
                      fontSize: "11px",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      marginTop: "4px",
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteContainer(containerName);
                    }}
                    title={`Delete ${containerName}`}
                  >
                    ✕
                  </button>
                </div>
              );
            })
          )}
        </div>
        {showBandControls && bandSourceFile && rasterInfo?.bands > 1 && (
          <section className="band-control-panel">
            <div className="band-source-summary">
              <div className="band-source-kicker">ACTIVE RASTER</div>
              <div title={getDisplayName(bandSourceFile)} className="band-source-name">{getDisplayName(bandSourceFile)}</div>
              <div className="band-source-container">Container <strong>{getContainerForFile(bandSourceFile) || activeContainer || "—"}</strong></div>
            </div>
            <div className="band-control-heading">
              <span>Band controls</span>
              <span className="band-count">{rasterInfo.bands} bands</span>
            </div>
            <label className="band-control-row band-display-row">
              <span>Display</span>
              <select aria-label="Displayed raster band" value={selectedRasterBand} onChange={handleRasterBandChange} className="band-select">
                {Array.from({ length: rasterInfo.bands }, (_, index) => <option key={index + 1} value={index + 1}>Band {index + 1}</option>)}
              </select>
            </label>
            <div className="rgb-band-group">
              <div className="rgb-band-heading">RGB composite</div>
              {[{ channel: "r", label: "Red", color: "#f07878" }, { channel: "g", label: "Green", color: "#69c99a" }, { channel: "b", label: "Blue", color: "#75a9ed" }].map(({ channel, label, color }) => (
                <label key={channel} className="band-control-row">
                  <span className="band-channel-label" style={{ color }}><span className={`channel-dot channel-${channel}`} />{label}</span>
                  <select aria-label={`${label} channel band`} value={rgbBandValues[channel]} onChange={(event) => handleRgbBandChange(channel, event.target.value)} className="band-select">
                  {Array.from({ length: rasterInfo.bands }, (_, index) => <option key={index + 1} value={index + 1}>Band {index + 1}</option>)}
                  </select>
                </label>
              ))}
              <button className="band-apply-button" onClick={applySelectedRasterRgb}>Apply RGB composite</button>
            </div>
          </section>
        )}
      </div>

      <div style={styles.mainContent}>
        <div style={styles.toolbar}>
          <div style={styles.toolGroup}>
            <span style={styles.groupLabel}>Navigation</span>
            <div style={styles.btnRow}>
              <button style={styles.iconBtn} onClick={handleZoomIn}>🔍 +</button>
              <button style={styles.iconBtn} onClick={handleZoomOut}>🔍 -</button>
              <button style={{ ...styles.iconBtn, color: "#f87171" }} onClick={resetView}>🎯 Reset</button>
              <button style={{ ...styles.iconBtn, background: showMinimap ? "#2563eb" : "#1e222d" }} onClick={() => setShowMinimap((s) => !s)}>🗺️ Minimap</button>
            </div>
          </div>
          <div style={styles.divider} />
          <div style={styles.toolGroup}>
            <span style={styles.groupLabel}>Compare</span>
            <div style={styles.btnRow}>
              <button style={{ ...styles.iconBtn, background: isSwipeMode ? "#2563eb" : "#1e222d", color: isSwipeMode ? "#ffffff" : "#e2e8f0" }} onClick={toggleSwipeMode}>🔀 Swipe Compare</button>
            </div>
          </div>
          <div style={styles.divider} />
          <div style={styles.toolGroup}>
            <span style={styles.groupLabel}>Analysis</span>
            <div style={styles.btnRow}>
              <button style={{ ...styles.iconBtn, opacity: activeFilesPool.length > 0 && !isSwipeMode ? 1 : 0.4 }} onClick={openHistogramModal} disabled={activeFilesPool.length === 0 || isSwipeMode}>📊 Histogram</button>
              <button style={{ ...styles.iconBtn, opacity: activeFilesPool.length > 0 && !isSwipeMode ? 1 : 0.4 }} onClick={openScatterPlotModal} disabled={activeFilesPool.length === 0 || isSwipeMode}>📈 Scatter Plot</button>
              <button style={{ ...styles.iconBtn, background: isProfileMode ? "#0d9488" : "#1e222d", opacity: activeFilesPool.length > 0 && !isSwipeMode ? 1 : 0.4 }} onClick={() => { if (activeFilesPool.length === 0 || isSwipeMode) return; if (isProfileMode) { setIsProfileMode(false); showToast("Profile mode canceled", "success"); } else { openProfilePlotModal(); } }} disabled={activeFilesPool.length === 0 || isSwipeMode}>📉 Profile Plot</button>
              <button style={{ ...styles.iconBtn, background: isRoiDrawing ? "#0e7490" : "#1e222d", opacity: activeFilesPool.length > 0 && !isSwipeMode ? 1 : 0.4 }} onClick={() => { if (!roiSourceFile || isSwipeMode) return; setIsProfileMode(false); setShowHistogram(false); setShowScatterPlot(false); setShowProfileModal(false); setShowRoiPanel(true); setIsRoiDrawing((active) => !active); }} disabled={activeFilesPool.length === 0 || isSwipeMode}>▧ ROI Rectangle</button>
            </div>
          </div>
          <div style={styles.divider} />
          <div style={styles.toolGroup}>
            <span style={styles.groupLabel}>RGB Composite ({activeContainer || "Select Container"})</span>
            <div style={styles.btnRow}>
              <div style={styles.selectPair}>
                <span style={{ color: "#ef4444", fontWeight: 700 }}>R</span>
                <select style={styles.selectInput} value={rFile} onChange={(e) => handleRGBChange("r", e.target.value)} disabled={!activeContainer || isSwipeMode}>
                  <option value="">Band...</option>
                  {activeFilesPool.map((f) => <option key={`r-${f}`} value={f}>{getDisplayName(f)}</option>)}
                </select>
                {isImageLoading && <span style={styles.inlineSpinner} />}
              </div>
              <div style={styles.selectPair}>
                <span style={{ color: "#22c55e", fontWeight: 700 }}>G</span>
                <select style={styles.selectInput} value={gFile} onChange={(e) => handleRGBChange("g", e.target.value)} disabled={!activeContainer || isSwipeMode}>
                  <option value="">Band...</option>
                  {activeFilesPool.map((f) => <option key={`g-${f}`} value={f}>{getDisplayName(f)}</option>)}
                </select>
                {isImageLoading && <span style={styles.inlineSpinner} />}
              </div>
              <div style={styles.selectPair}>
                <span style={{ color: "#3b82f6", fontWeight: 700 }}>B</span>
                <select style={styles.selectInput} value={bFile} onChange={(e) => handleRGBChange("b", e.target.value)} disabled={!activeContainer || isSwipeMode}>
                  <option value="">Band...</option>
                  {activeFilesPool.map((f) => <option key={`b-${f}`} value={f}>{getDisplayName(f)}</option>)}
                </select>
                {isImageLoading && <span style={styles.inlineSpinner} />}
              </div>
            </div>
          </div>
          <div style={styles.divider} />
          <div style={styles.toolGroup}>
            <span style={styles.groupLabel}>Export</span>
            <div style={styles.btnRow}>
              <button style={{ ...styles.iconBtn, opacity: displayedImageUrl && !isSwipeMode ? 1 : 0.4 }} onClick={handleDownload} disabled={!displayedImageUrl || isSwipeMode}>⬇ Download</button>
            </div>
          </div>
        </div>

        {isSwipeMode && (
          <div className="swipe-toolbar">
            <label className="swipe-layer-control"><span className="swipe-layer-label swipe-left-label">Left layer</span>
              <select aria-label="Left comparison layer" value={swipeLeftFile} onChange={(e) => { setSwipeLeftLoading(true); setSwipeLeftFile(e.target.value); }}>
                {activeFilesPool.map((f) => <option key={`sw-l-${f}`} value={f}>{getDisplayName(f)}</option>)}
              </select>
              {swipeLeftLoading && <span style={styles.inlineSpinner} />}
            </label>
            <label className="swipe-layer-control"><span className="swipe-layer-label swipe-right-label">Right layer</span>
              <select aria-label="Right comparison layer" value={swipeRightFile} onChange={(e) => { setSwipeRightLoading(true); setSwipeRightFile(e.target.value); }}>
                {activeFilesPool.map((f) => <option key={`sw-r-${f}`} value={f}>{getDisplayName(f)}</option>)}
              </select>
              {swipeRightLoading && <span style={styles.inlineSpinner} />}
            </label>
            <div className="swipe-toolbar-actions">
              <span className="swipe-zoom-value">Zoom <strong>{Math.round(scale * 100)}%</strong></span>
              <button title="Swap comparison layers" onClick={() => { setSwipeLeftLoading(true); setSwipeRightLoading(true); setSwipeLeftFile(swipeRightFile); setSwipeRightFile(swipeLeftFile); setSwipePosition(100 - swipePosition); }}>Swap</button>
              <button title="Center comparison divider" onClick={() => setSwipePosition(50)}>Center</button>
            </div>
          </div>
        )}

        {!isSwipeMode && rasterInfo && (
          <div style={styles.metaStrip}>
            <span><strong>Layer:</strong> {getDisplayName(selectedFile) || rasterInfo.filename}</span>
            <span><strong>Container:</strong> {getContainerForFile(selectedFile) || "None"}</span>
            <span><strong>Size:</strong> {rasterInfo.width} × {rasterInfo.height}</span>
            <span><strong>Bands:</strong> {rasterInfo.bands}</span>
            <span><strong>Zoom:</strong> {Math.round(scale * 100)}%</span>
          </div>
        )}

        <div ref={containerRef} style={{ ...styles.viewport, position: "relative", overflow: "hidden" }}>
          {isSwipeMode ? (
            <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
              <div style={{ position: "absolute", width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <img src={`${API}/image?filename=${encodeURIComponent(swipeRightFile)}`} alt="Right Layer" draggable={false} style={getImageStyle} onLoad={() => setSwipeRightLoading(false)} onError={() => setSwipeRightLoading(false)} />
              </div>
              <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: `${swipePosition}%`, overflow: "hidden", pointerEvents: "none" }}>
                <div style={{ position: "absolute", top: 0, left: 0, width: containerRef.current ? `${containerRef.current.clientWidth}px` : "100vw", height: containerRef.current ? `${containerRef.current.clientHeight}px` : "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <img src={`${API}/image?filename=${encodeURIComponent(swipeLeftFile)}`} alt="Left Layer" draggable={false} style={getImageStyle} onLoad={() => setSwipeLeftLoading(false)} onError={() => setSwipeLeftLoading(false)} />
                </div>
              </div>
              <div className="swipe-layer-tag swipe-tag-left">A · {getDisplayName(swipeLeftFile)}</div>
              <div className="swipe-layer-tag swipe-tag-right">B · {getDisplayName(swipeRightFile)}</div>
              <div
                className="swipe-divider"
                role="slider"
                tabIndex={0}
                aria-label="Swipe comparison position"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(swipePosition)}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  setIsDraggingSwipeDivider(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); setSwipePosition((value) => Math.max(0, value - 2)); }
                  if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); setSwipePosition((value) => Math.min(100, value + 2)); }
                  if (event.key === "Home") { event.preventDefault(); setSwipePosition(0); }
                  if (event.key === "End") { event.preventDefault(); setSwipePosition(100); }
                }}
                style={{ left: `${swipePosition}%` }}
              >
                <div className="swipe-divider-handle">↔</div>
              </div>
            </div>
          ) : (
            <>
              {displayedImageUrl && showOverviewInViewport && (
  <img
    src={displayedImageUrl}
    alt="raster overview"
    draggable={false}
    onPointerDown={(e) => {
      if (osdFirstTileRef.current) return;
      e.preventDefault();
      fallbackDragRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        originX: position.x,
        originY: position.y,
      };
      userHasSetViewRef.current = true;
    }}
    onError={(e) => { e.currentTarget.style.display = "none"; }}
    style={{
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "contain",
      objectPosition: "center",
      zIndex: 5,
      pointerEvents: "none",
      userSelect: "none",
      touchAction: "none",
      cursor: osdFirstTileRef.current ? "default" : "grab",
      transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
      transformOrigin: "center center",
    }}
  />
)}
              <div
                id="osd-viewer"
                ref={osdContainerRef}
                style={{ position: "absolute", inset: 0, background: "transparent", zIndex: 20, cursor: "grab", touchAction: "none", pointerEvents: "auto" }}
              />
              {roiScreenRect && (roiSelection?.filename === roiSourceFile || roiDraft) && (
                <div style={{ position: "absolute", left: roiScreenRect.left, top: roiScreenRect.top, width: Math.max(1, roiScreenRect.width), height: Math.max(1, roiScreenRect.height), border: roiDraft ? "2px dashed #facc15" : "2px solid #facc15", background: "rgba(250,204,21,0.12)", boxShadow: "0 0 0 1px rgba(0,0,0,0.7)", pointerEvents: "none", zIndex: 26 }} />
              )}
            </>
          )}
          {isImageLoading && !isSwipeMode && (
            <div style={styles.loadingBadge}>
              <div style={styles.spinnerSmall} /><span>Loading preview…</span>
            </div>
          )}
{!isSwipeMode && displayedImageUrl && showMinimap && (
  <div
    title="Click to move viewport"
    onPointerDown={(e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      minimapDragRef.current.active = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      panFromMinimapPointer(e, e.currentTarget);
    }}
    onPointerMove={(e) => {
      if (!minimapDragRef.current.active) return;
      e.preventDefault();
      panFromMinimapPointer(e, e.currentTarget);
    }}
    onPointerUp={(e) => {
      minimapDragRef.current.active = false;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      saveCurrentImageHistory();
    }}
    onPointerCancel={() => { minimapDragRef.current.active = false; }}
    style={{
      position: "absolute",
      right: "20px",
      bottom: "20px",
      width: "280px",
      height: "200px",
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: "6px",
      overflow: "hidden",
      background: "#0b0d11",
      boxShadow: "0 6px 18px rgba(0,0,0,0.6)",
      zIndex: 30,               // important – keep it above the image
      cursor: "crosshair",
    }}
  >
    <img
      src={displayedImageUrl}
      alt="minimap"
      style={{
        width: "100%",
        height: "100%",
        objectFit: "contain",
        objectPosition: "center",
        display: "block",
        backgroundColor: "#0b0d11",
      }}
      draggable={false}
    />

    {roiSelection?.filename === roiSourceFile && (() => {
      const { width: rasterWidth, height: rasterHeight } = currentRasterSizeRef.current;
      if (!rasterWidth || !rasterHeight) return null;
      const rasterAspect = rasterWidth / rasterHeight;
      const containerAspect = 280 / 200;
      let left = roiSelection.x / rasterWidth;
      let top = roiSelection.y / rasterHeight;
      let width = roiSelection.width / rasterWidth;
      let height = roiSelection.height / rasterHeight;
      if (rasterAspect > containerAspect) {
        const ratio = containerAspect / rasterAspect;
        top = (1 - ratio) / 2 + top * ratio;
        height *= ratio;
      } else {
        const ratio = rasterAspect / containerAspect;
        left = (1 - ratio) / 2 + left * ratio;
        width *= ratio;
      }
      return <div style={{ position: "absolute", left: `${left * 100}%`, top: `${top * 100}%`, width: `${width * 100}%`, height: `${height * 100}%`, border: "2px solid #facc15", background: "rgba(250,204,21,0.22)", boxSizing: "border-box", pointerEvents: "none", zIndex: 6 }} />;
    })()}

    {/* Blue box – keep the aspect-ratio corrected version you already have */}
    {(() => {
      const { width: rw, height: rh } = currentRasterSizeRef.current;
      if (!rw || !rh) return null;

      const rasterAspect = rw / rh;
      const containerAspect = 280 / 200;

      let left = miniRect.left;
      let top = miniRect.top;
      let w = Math.max(miniRect.width, 0.01);
      let h = Math.max(miniRect.height, 0.01);

      if (rasterAspect > containerAspect) {
        const ratio = containerAspect / rasterAspect;
        const offset = (1 - ratio) / 2;
        top = offset + top * ratio;
        h = h * ratio;
      } else {
        const ratio = rasterAspect / containerAspect;
        const offset = (1 - ratio) / 2;
        left = offset + left * ratio;
        w = w * ratio;
      }

      return (
        <div
          style={{
            position: "absolute",
            border: "3px solid #00e5ff",
            boxSizing: "border-box",
            pointerEvents: "none",
            backgroundColor: "rgba(0,229,255,0.18)",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.85), 0 0 10px rgba(0,229,255,0.9)",
            zIndex: 5,
            left: `${left * 100}%`,
            top: `${top * 100}%`,
            width: `${Math.max(w * 100, 1.5)}%`,
            height: `${Math.max(h * 100, 1.5)}%`,
          }}
        />
      );
    })()}
  </div>
)}
        </div>
      </div>

      {showContainerModal && (
        <div style={styles.modalBackdrop}>
          <div style={styles.modalBox}>
            <h3 style={styles.modalTitle}>Choose Storage Container</h3>
            <p style={styles.modalSubtitle}>Select an existing container or create a new one for your files.</p>
            <div style={styles.modalContainerList}>
              {Object.keys(containers).map((cName) => (
                <button key={cName} style={styles.modalOptionBtn} onClick={() => processUploadsToContainer(cName, pendingFiles)}>
                  📁 {cName} ({containers[cName].length} files)
                </button>
              ))}
              <button style={{ ...styles.modalOptionBtn, backgroundColor: "#2563eb", color: "#fff", borderColor: "#2563eb" }} onClick={() => { const newName = getNextContainerName(); processUploadsToContainer(newName, pendingFiles); }}>
                ➕ Create New Container ({getNextContainerName()})
              </button>
            </div>
            <button style={styles.modalCancelBtn} onClick={() => { setShowContainerModal(false); setPendingFiles([]); }}>Cancel</button>
          </div>
        </div>
      )}

      {showHistogram && (
        <div className="histogram-panel" style={{ ...styles.histPanel, width: "min(420px, calc(100vw - 16px))" }}>
          <div className="histogram-panel-header">
            <div>
              <div className="histogram-kicker">RASTER ANALYSIS</div>
              <h3>Histogram</h3>
            </div>
            <button className="histogram-close" aria-label="Close histogram" onClick={closeHistogramAndRestore}>×</button>
          </div>
          <div className="histogram-source-picker">
            <label htmlFor="histogram-source">Source raster</label>
            <select id="histogram-source" value={histDropdownFile} onChange={(event) => {
              const file = event.target.value;
              setHistDropdownFile(file);
              setHistDefaultData(null);
              setHistSelectedRange(null);
              fetchHistogramFor(file, setHistDefaultLoading, setHistDefaultData);
            }}>
              {activeFilesPool.map((file) => <option key={file} value={file}>{getDisplayName(file)}</option>)}
            </select>
          </div>
          <div className="histogram-scope">Container <strong>{activeContainer || "None"}</strong></div>
          <div className="histogram-channel-tabs" role="tablist" aria-label="Histogram channel">
            <button role="tab" aria-selected={histActiveChannel === null} className={histActiveChannel === null ? "is-active" : ""} onClick={() => {
              setHistActiveChannel(null);
              fetchHistogramFor(histDropdownFile, setHistDefaultLoading, setHistDefaultData);
            }}>Raster</button>
            {[{ ch: "r", label: "Red", color: "#e77e7e", file: rFile }, { ch: "g", label: "Green", color: "#68bd91", file: gFile }, { ch: "b", label: "Blue", color: "#729fe0", file: bFile }].map(({ ch, label, color, file }) => (
              <button key={ch} role="tab" aria-selected={histActiveChannel === ch} className={histActiveChannel === ch ? "is-active" : ""} style={{ "--hist-channel": color }} disabled={!file} onClick={() => selectHistChannel(ch)}>{label}</button>
            ))}
          </div>
          {histSelectedRange && typeof histSelectedRange.min === "number" && typeof histSelectedRange.max === "number" && (
            <div className="histogram-range-summary">
              <div><span>Active display range</span><button onClick={() => { setHistSelectedRange(null); setHistSelectedChannel(null); }}>Clear</button></div>
              <strong>{histSelectedRange.min.toPrecision(5)} to {histSelectedRange.max.toPrecision(5)}</strong>
            </div>
          )}
          {histActiveChannel === null && renderHistogramBlock("default", "#38bdf8", "Selected Image", histDropdownFile, histDefaultData, histDefaultLoading)}
          {histActiveChannel === "r" && renderHistogramBlock("r", "#ef4444", "Red Channel", rFile, histR, histRLoading)}
          {histActiveChannel === "g" && renderHistogramBlock("g", "#22c55e", "Green Channel", gFile, histG, histGLoading)}
          {histActiveChannel === "b" && renderHistogramBlock("b", "#3b82f6", "Blue Channel", bFile, histB, histBLoading)}
        </div>
      )}

      {showScatterPlot && (
        <div className="analysis-panel" style={styles.sidePanel}>
          <div className="analysis-panel-header">
            <div><div className="analysis-kicker">BAND RELATIONSHIP</div><h3>Scatter plot</h3></div>
            <button className="analysis-close" aria-label="Close scatter plot" onClick={() => setShowScatterPlot(false)}>×</button>
          </div>
          <div className="scatter-config">
            <div className="scatter-axis-config">
              <span className="scatter-axis-badge scatter-x-badge">X</span>
              <div className="scatter-axis-fields">
                <select aria-label="X axis raster" value={scatterXFile} onChange={(event) => {
                  const file = event.target.value;
                  setScatterXFile(file);
                  setScatterXBand(1);
                  fetchScatterPlotData(file, 1, scatterYFile, scatterYBand);
                }}>
                  {activeFilesPool.map((file) => <option key={`sx-${file}`} value={file}>{getDisplayName(file)}</option>)}
                </select>
                <select aria-label="X axis band" value={scatterXBand} onChange={(event) => {
                  const band = Number(event.target.value);
                  setScatterXBand(band);
                  fetchScatterPlotData(scatterXFile, band, scatterYFile, scatterYBand);
                }}>
                  {Array.from({ length: scatterXBandCount }, (_, index) => <option key={index + 1} value={index + 1}>Band {index + 1}</option>)}
                </select>
              </div>
            </div>
            <div className="scatter-axis-config">
              <span className="scatter-axis-badge scatter-y-badge">Y</span>
              <div className="scatter-axis-fields">
                <select aria-label="Y axis raster" value={scatterYFile} onChange={(event) => {
                  const file = event.target.value;
                  setScatterYFile(file);
                  setScatterYBand(1);
                  fetchScatterPlotData(scatterXFile, scatterXBand, file, 1);
                }}>
                  {activeFilesPool.map((file) => <option key={`sy-${file}`} value={file}>{getDisplayName(file)}</option>)}
                </select>
                <select aria-label="Y axis band" value={scatterYBand} onChange={(event) => {
                  const band = Number(event.target.value);
                  setScatterYBand(band);
                  fetchScatterPlotData(scatterXFile, scatterXBand, scatterYFile, band);
                }}>
                  {Array.from({ length: scatterYBandCount }, (_, index) => <option key={index + 1} value={index + 1}>Band {index + 1}</option>)}
                </select>
              </div>
            </div>
          </div>
          {isScatterLoading ? (
            <div className="analysis-loading"><span className="analysis-spinner" />Sampling paired raster values</div>
          ) : scatterError ? (
            <div className="analysis-error">{scatterError}</div>
          ) : scatterData?.points?.length ? (
            (() => {
              const xRange = scatterData.xMax - scatterData.xMin || 1;
              const yRange = scatterData.yMax - scatterData.yMin || 1;
              const meanX = scatterData.points.reduce((sum, point) => sum + point.x, 0) / scatterData.points.length;
              const meanY = scatterData.points.reduce((sum, point) => sum + point.y, 0) / scatterData.points.length;
              const covariance = scatterData.points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
              const varianceX = scatterData.points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
              const varianceY = scatterData.points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
              const correlation = varianceX && varianceY ? covariance / Math.sqrt(varianceX * varianceY) : 0;
              return <>
                <div className="scatter-plot-summary"><span>{scatterData.points.length.toLocaleString()} paired samples</span><span>Correlation <strong>{correlation.toFixed(3)}</strong></span></div>
                <div className="scatter-plot-stage">
                  <div className="scatter-grid-lines" />
                  {scatterData.points.map((point, index) => {
                    const left = Math.min(100, Math.max(0, ((point.x - scatterData.xMin) / xRange) * 100));
                    const bottom = Math.min(100, Math.max(0, ((point.y - scatterData.yMin) / yRange) * 100));
                    return <div key={index} title={`X ${point.x.toPrecision(5)} · Y ${point.y.toPrecision(5)}`} className="scatter-dot" style={{ left: `${left}%`, bottom: `${bottom}%` }} />;
                  })}
                </div>
                <div className="scatter-axis-ticks"><span>{scatterData.xMin.toPrecision(5)}</span><span>{meanX.toPrecision(5)}</span><span>{scatterData.xMax.toPrecision(5)}</span></div>
                <div className="scatter-axis-caption"><span>X: {getDisplayName(scatterXFile)} · Band {scatterXBand}</span><span>Y: {getDisplayName(scatterYFile)} · Band {scatterYBand}</span></div>
                <div className="scatter-y-range">Y range {scatterData.yMin.toPrecision(5)} – {scatterData.yMax.toPrecision(5)}</div>
              </>;
            })()
          ) : (
            <div className="analysis-empty">Choose two raster bands to calculate a comparison.</div>
          )}
        </div>
      )}

      {showProfileModal && (
        <div className="analysis-panel" style={styles.sidePanel}>
          <div className="analysis-panel-header">
            <div><div className="analysis-kicker">TRANSECT ANALYSIS</div><h3>Profile plot</h3></div>
            <button className="analysis-close" aria-label="Close profile plot" onClick={() => { setShowProfileModal(false); setIsProfileMode(false); }}>×</button>
          </div>
          <div className="profile-config">
            <label><span>Source raster</span><select value={profileFile} onChange={(event) => {
              const file = event.target.value;
              setProfileFile(file);
              setSelectedProfileBand(1);
              if (profileStart && profileEnd) fetchProfilePlot(profileStart, profileEnd, file, 1);
            }}>
              {activeFilesPool.map((file) => <option key={`pf-${file}`} value={file}>{getDisplayName(file)}</option>)}
            </select></label>
            <label><span>Band</span><select value={selectedProfileBand} onChange={(event) => {
              const band = Number(event.target.value);
              setSelectedProfileBand(band);
              if (profileStart && profileEnd) fetchProfilePlot(profileStart, profileEnd, profileFile, band);
            }}>
              {Array.from({ length: profileBandCount }, (_, index) => <option key={index + 1} value={index + 1}>Band {index + 1}</option>)}
            </select></label>
          </div>
          {isProfileMode ? (
            <div className="analysis-instruction"><span className="analysis-step">{profileStart ? "2" : "1"}</span><div><strong>{profileStart ? "Choose the end point" : "Choose the start point"}</strong><span>{profileStart ? `Start: pixel ${profileStart.x}, ${profileStart.y}` : "Click the image to place the profile start."}</span></div><button onClick={() => { setIsProfileMode(false); setProfileStart(null); setProfileEnd(null); }}>Cancel</button></div>
          ) : null}
          {isProfileLoading ? (
            <div className="analysis-loading"><span className="analysis-spinner" />Sampling raster profile</div>
          ) : profileError ? (
            <div className="analysis-error">{profileError}</div>
          ) : profileData?.values?.length ? (
            <>
              <div className="profile-chart-heading"><span>Pixel values</span><span>{profileData.values.length} samples</span></div>
              <div className="profile-chart-stage">
                <div className="profile-chart-grid" />
                <svg viewBox="0 0 1000 300" preserveAspectRatio="none" role="img" aria-label={`Band ${selectedProfileBand} pixel profile`}>
                  <polyline fill="none" stroke="#68bdad" strokeWidth="3" vectorEffect="non-scaling-stroke" points={profileData.values.map((value, index) => {
                    const valueRange = profileData.max - profileData.min || 1;
                    const x = profileData.values.length < 2 ? 500 : (index / (profileData.values.length - 1)) * 1000;
                    const y = 290 - ((value - profileData.min) / valueRange) * 280;
                    return `${x},${y}`;
                  }).join(" ")} />
                </svg>
              </div>
              <div className="profile-chart-axis"><span>Start · {profileData.start.x}, {profileData.start.y}</span><span>End · {profileData.end.x}, {profileData.end.y}</span></div>
              <div className="profile-statistics">
                <div><span>Minimum</span><strong>{profileData.min.toPrecision(5)}</strong></div>
                <div><span>Maximum</span><strong>{profileData.max.toPrecision(5)}</strong></div>
                <div><span>Mean</span><strong>{(profileData.values.reduce((sum, value) => sum + value, 0) / profileData.values.length).toPrecision(5)}</strong></div>
              </div>
            </>
          ) : !isProfileMode ? (
            <div className="analysis-empty">Choose Profile Plot, then click two points on the raster.</div>
          ) : null}
        </div>
      )}

      {showRoiPanel && (
        <div style={styles.sidePanel}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <h3 style={{ margin: 0, fontSize: "14px", color: "#f8fafc" }}>Region of Interest</h3>
            <button style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "16px" }} onClick={() => { setShowRoiPanel(false); setIsRoiDrawing(false); }}>✕</button>
          </div>
          {roiSelection ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "6px", padding: "10px", marginBottom: "12px", background: "#14171d", border: "1px solid #2a2d34", borderRadius: "4px", color: "#cbd5e1", fontSize: "11px" }}>
                <div>X: <strong>{roiSelection.x}</strong></div>
                <div>Y: <strong>{roiSelection.y}</strong></div>
                <div>Width: <strong>{roiSelection.width}</strong></div>
                <div>Height: <strong>{roiSelection.height}</strong></div>
                <div style={{ gridColumn: "1 / -1" }}>Pixels: <strong>{(roiSelection.width * roiSelection.height).toLocaleString()}</strong></div>
              </div>
              {roiAnalysis?.extent?.geographic_bounds && (
                <div style={{ color: "#94a3b8", fontSize: "10px", lineHeight: 1.5, marginBottom: "12px" }}>
                  Geographic extent (W, S, E, N): {roiAnalysis.extent.geographic_bounds.map((value) => value.toFixed(6)).join(", ")}
                </div>
              )}
              {roiAnalysis?.extent?.crs && <div style={{ color: "#64748b", fontSize: "10px", marginBottom: "12px" }}>Source CRS: {roiAnalysis.extent.crs}</div>}
              {isRoiLoading ? (
                <div style={{ textAlign: "center", padding: "28px", color: "#94a3b8", fontSize: "12px" }}>Analyzing selected pixels across bands…</div>
              ) : roiAnalysis ? (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0 6px" }}>
                    <strong style={{ color: "#e2e8f0", fontSize: "12px" }}>Spectral profile</strong>
                    <span style={{ color: "#64748b", fontSize: "10px" }}>{roiAnalysis.bands.length} bands</span>
                  </div>
                  {(() => {
                    const valid = roiAnalysis.bands.filter((item) => Number.isFinite(item.mean));
                    const minimum = valid.length ? Math.min(...valid.map((item) => item.mean)) : 0;
                    const maximum = valid.length ? Math.max(...valid.map((item) => item.mean)) : 1;
                    const range = maximum === minimum ? 1 : maximum - minimum;
                    return <div style={{ height: "112px", overflowX: "auto", overflowY: "hidden", background: "#101319", borderBottom: "1px solid #334155", marginBottom: "4px" }}>
                      <div style={{ height: "100%", minWidth: `${Math.max(100, roiAnalysis.bands.length * 2)}px`, display: "flex", alignItems: "flex-end", gap: "1px", padding: "4px 2px 0" }}>
                        {roiAnalysis.bands.map((item) => {
                          const height = Number.isFinite(item.mean) ? Math.max(2, ((item.mean - minimum) / range) * 100) : 0;
                          return <div key={item.band} title={`Band ${item.band}: ${item.mean == null ? "no data" : item.mean}`} style={{ flex: 1, minWidth: "1px", height: `${height}%`, background: "#39b7a5", opacity: item.band === selectedRoiBand ? 1 : 0.7 }} />;
                        })}
                      </div>
                    </div>;
                  })()}
                  <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b", fontSize: "9px", marginBottom: "14px" }}><span>Band 1</span><span>Band {roiAnalysis.bands.length}</span></div>

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "7px" }}>
                    <strong style={{ color: "#e2e8f0", fontSize: "12px" }}>ROI histogram</strong>
                    <select value={selectedRoiBand} onChange={(event) => setSelectedRoiBand(Number(event.target.value))} style={styles.selectInput}>
                      {roiAnalysis.bands.map((item) => <option key={item.band} value={item.band}>Band {item.band}</option>)}
                    </select>
                  </div>
                  {(() => {
                    const histogram = roiAnalysis.histograms.find((item) => item.band === selectedRoiBand);
                    const maxCount = Math.max(1, ...(histogram?.counts || []));
                    return histogram?.binEdges.length ? <div style={{ height: "100px", display: "flex", alignItems: "flex-end", gap: "2px", padding: "6px 4px", background: "#14171d", border: "1px solid #2a2d34" }}>
                      {histogram.counts.map((count, index) => <div key={index} title={`${histogram.binEdges[index].toPrecision(4)} – ${histogram.binEdges[index + 1].toPrecision(4)}: ${count}`} style={{ flex: 1, minWidth: "2px", height: `${Math.max(1, (count / maxCount) * 100)}%`, background: "#5ca6dc" }} />)}
                    </div> : <div style={{ color: "#64748b", fontSize: "11px", padding: "18px 0" }}>No valid pixels in this band.</div>;
                  })()}

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 6px" }}>
                    <strong style={{ color: "#e2e8f0", fontSize: "12px" }}>Band statistics</strong>
                    <span style={{ color: "#64748b", fontSize: "9px" }}>min · max · mean · median · std</span>
                  </div>
                  <div style={{ maxHeight: "180px", overflow: "auto", border: "1px solid #2a2d34" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", color: "#cbd5e1", fontSize: "10px", textAlign: "right" }}>
                      <thead><tr style={{ position: "sticky", top: 0, background: "#1b202a", color: "#94a3b8" }}><th style={{ padding: "5px", textAlign: "left" }}>Band</th><th>Min</th><th>Max</th><th>Mean</th><th>Median</th><th>Std</th></tr></thead>
                      <tbody>{roiAnalysis.bands.map((item) => <tr key={item.band} style={{ borderTop: "1px solid #242a34", background: item.band === selectedRoiBand ? "rgba(57,183,165,0.08)" : "transparent" }}>
                        <td style={{ padding: "5px", textAlign: "left" }}>{item.band}</td>
                        {[item.min, item.max, item.mean, item.median, item.std].map((value, index) => <td key={index} style={{ padding: "5px" }}>{Number.isFinite(value) ? value.toPrecision(5) : "—"}</td>)}
                      </tr>)}</tbody>
                    </table>
                  </div>
                  <button style={{ ...styles.iconBtn, width: "100%", marginTop: "14px", background: "#0e7490", justifyContent: "center", opacity: isRoiAiLoading ? 0.7 : 1 }} onClick={analyzeRoiWithAi} disabled={isRoiAiLoading}>
                    {isRoiAiLoading ? "Analyzing ROI…" : "Analyze ROI with AI"}
                  </button>
                  {roiAiAnalysis && <div style={{ marginTop: "10px", padding: "10px", background: "#14171d", border: "1px solid #2a2d34", color: "#cbd5e1", fontSize: "11px", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{roiAiAnalysis}</div>}
                  <button style={{ ...styles.iconBtn, width: "100%", marginTop: "8px", justifyContent: "center" }} onClick={() => { setRoiSelection(null); setRoiAnalysis(null); setRoiAiAnalysis(""); setRoiScreenRect(null); setIsRoiDrawing(true); }}>Draw another ROI</button>
                </>
              ) : !isRoiLoading ? <div style={{ color: "#64748b", fontSize: "11px" }}>ROI statistics are unavailable.</div> : null}
            </>
          ) : (
            <div style={{ color: "#94a3b8", fontSize: "12px", lineHeight: 1.5 }}>
              {isRoiDrawing ? "Drag a rectangle across the raster." : "Choose ROI Rectangle, then drag across the raster."}
            </div>
          )}
        </div>
      )}

      {toast && (
        <div style={{ ...styles.toast, ...(toast.type === "success" ? styles.toastSuccess : styles.toastError) }}>
          {toast.message}
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      {/* Pixel Value + Coordinates */}
{mouseInfo && !isSwipeMode && (
  <div style={{
    position: "absolute",
    left: "12px",
    bottom: "12px",
    background: "rgba(15, 18, 25, 0.92)",
    border: "1px solid #1e222d",
    borderRadius: "6px",
    padding: "8px 12px",
    fontSize: "12px",
    color: "#e2e8f0",
    zIndex: 30,
    pointerEvents: "none",
    minWidth: "180px",
    lineHeight: "1.5",
  }}>
    <div><strong>X:</strong> {mouseInfo.x} &nbsp; <strong>Y:</strong> {mouseInfo.y}</div>
    {mouseInfo.longitude != null && mouseInfo.latitude != null && (
      <div>
        <strong>Lon:</strong> {mouseInfo.longitude.toFixed(5)} &nbsp;
        <strong>Lat:</strong> {mouseInfo.latitude.toFixed(5)}
      </div>
    )}
    <div>
      <strong>Value:</strong>{" "}
      {mouseInfo.value != null ? mouseInfo.value.toFixed(3) : "—"}
    </div>
  </div>
)}
    </div>
  );
}

const styles = {
  appContainer: { display: "flex", height: "100vh", width: "100vw", backgroundColor: "#0b0d11", color: "#e2e8f0", fontFamily: "Inter, sans-serif", userSelect: "none", overflow: "hidden" },
  sidebar: { width: "280px", borderRight: "1px solid #1e222d", padding: "16px", display: "flex", flexDirection: "column", backgroundColor: "#0f1219", flexShrink: 0 },
  sidebarHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" },
  sidebarTitle: { margin: 0, fontSize: "18px", fontWeight: "700", color: "#f8fafc" },
  versionBadge: { fontSize: "11px", background: "#1e293b", color: "#94a3b8", padding: "2px 6px", borderRadius: "4px" },
  uploadBtn: { display: "flex", alignItems: "center", justifyContent: "center", background: "#2563eb", color: "#ffffff", padding: "10px", borderRadius: "6px", fontWeight: "600", fontSize: "13px", cursor: "pointer", marginBottom: "20px" },
  uploadProgressContainer: { marginBottom: "16px" },
  progressText: { fontSize: "11px", color: "#94a3b8", marginBottom: "4px" },
  progressBarBg: { background: "#1e293b", height: "4px", borderRadius: "2px", overflow: "hidden" },
  progressBarFill: { background: "#22c55e", height: "100%" },
  sectionHeader: { fontSize: "12px", fontWeight: "600", textTransform: "uppercase", color: "#64748b", marginBottom: "12px", display: "flex", justifyContent: "space-between" },
  badge: { background: "#1e293b", color: "#94a3b8", padding: "1px 6px", borderRadius: "10px", fontSize: "10px" },
  rasterList: { display: "flex", flexDirection: "column", gap: "12px", overflowY: "auto", flex: 1 },
  containerGroup: { display: "flex", flexDirection: "column", gap: "6px", border: "1px solid #1e222d", borderRadius: "6px", padding: "6px", cursor: "pointer", transition: "all 0.15s ease" },
  containerHeaderBar: { fontSize: "11px", fontWeight: "700", color: "#38bdf8", textTransform: "uppercase", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px" },
  emptyStateText: { fontSize: "12px", color: "#475569", textAlign: "center", marginTop: "20px", fontStyle: "italic" },
  rasterCard: { display: "grid", gridTemplateColumns: "42px 1fr 26px", alignItems: "center", gap: "12px", padding: "10px", borderWidth: "1px", borderStyle: "solid", borderRadius: "6px", cursor: "pointer" },
  thumbnail: { width: "42px", height: "42px", objectFit: "cover", borderRadius: "4px", border: "1px solid #2a2d34" },
  rasterInfoText: { overflow: "hidden", minWidth: 0 },
  rasterName: { fontSize: "13px", fontWeight: "600", color: "#f1f5f9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  rasterSubtext: { fontSize: "11px", color: "#64748b", marginTop: "2px" },
  deleteBtn: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: "14px" },
  mainContent: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0 },
  toolbar: { minHeight: "68px", backgroundColor: "#0f1219", borderBottom: "1px solid #1e222d", display: "flex", alignItems: "center", padding: "8px 20px", gap: "16px", overflowX: "auto" },
  toolGroup: { display: "flex", flexDirection: "column", gap: "6px", flexShrink: 0, position: "relative" },
  groupLabel: { fontSize: "10px", fontWeight: "600", textTransform: "uppercase", color: "#64748b" },
  btnRow: { display: "flex", alignItems: "center", gap: "10px" },
  iconBtn: { background: "#1e222d", border: "1px solid #2a2d34", color: "#e2e8f0", padding: "6px 12px", borderRadius: "5px", fontSize: "12px", cursor: "pointer", display: "flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" },
  selectInput: { background: "#14171d", color: "#f8fafc", border: "1px solid #2a2d34", padding: "5px 8px", borderRadius: "5px", fontSize: "12px", outline: "none", cursor: "pointer" },
  selectPair: { display: "flex", alignItems: "center", gap: "4px" },
  stretchBtn: { background: "#1e293b", border: "1px solid #2a2d34", color: "#e2e8f0", padding: "4px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap" },
  stretchInput: { background: "#0b0d11", color: "#f8fafc", border: "1px solid #2a2d34", padding: "5px 8px", borderRadius: "5px", fontSize: "11px", outline: "none", width: "50%" },
  inlineSpinner: { width: "12px", height: "12px", border: "2px solid #38bdf8", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 },
  divider: { width: "1px", height: "36px", backgroundColor: "#1e222d", flexShrink: 0 },
  metaStrip: { height: "32px", backgroundColor: "#0b0d11", borderBottom: "1px solid #1e222d", display: "flex", alignItems: "center", padding: "0 20px", gap: "20px", fontSize: "12px", color: "#94a3b8", flexShrink: 0, overflowX: "auto", overflowY: "hidden" },
  viewport: { flex: 1, position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#07090c" },
  rasterImageStyle: { position: "absolute", maxWidth: "none", maxHeight: "none", pointerEvents: "none", display: "block" },
  placeholder: { color: "#475569", fontSize: "14px", fontStyle: "italic" },
  loadingBadge: { position: "absolute", bottom: "20px", right: "20px", backgroundColor: "#0f1219", border: "1px solid #1e222d", padding: "8px 16px", borderRadius: "6px", display: "flex", alignItems: "center", gap: "10px", fontSize: "12px", color: "#f8fafc", boxShadow: "0 4px 12px rgba(0,0,0,0.5)", zIndex: 10 },
  spinnerSmall: { width: "14px", height: "14px", border: "2px solid #38bdf8", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" },
  toast: { position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)", padding: "10px 20px", borderRadius: "6px", fontSize: "13px", fontWeight: "500", zIndex: 2000, boxShadow: "0 4px 12px rgba(0,0,0,0.5)" },
  toastSuccess: { backgroundColor: "#065f46", color: "#d1fae5", border: "1px solid #059669" },
  toastError: { backgroundColor: "#991b1b", color: "#fee2e2", border: "1px solid #dc2626" },
  modalBackdrop: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000 },
  modalBox: { backgroundColor: "#0f1219", border: "1px solid #1e222d", borderRadius: "8px", padding: "24px", width: "360px", boxShadow: "0 8px 24px rgba(0,0,0,0.6)" },
  sidePanel: { position: "fixed", top: 0, right: 0, bottom: 0, width: "360px", backgroundColor: "#0f1219", borderLeft: "1px solid #1e222d", boxShadow: "-8px 0 24px rgba(0,0,0,0.5)", zIndex: 900, overflowY: "auto", padding: "20px" },
  histPanel: { position: "fixed", top: 0, right: 0, bottom: 0, width: "360px", backgroundColor: "#0f1219", borderLeft: "1px solid #1e222d", boxShadow: "-8px 0 24px rgba(0,0,0,0.5)", zIndex: 900, overflowY: "auto", padding: "20px" },
  modalTitle: { margin: "0 0 8px 0", fontSize: "16px", fontWeight: "700", color: "#f8fafc" },
  modalSubtitle: { margin: "0 0 16px 0", fontSize: "12px", color: "#94a3b8" },
  modalContainerList: { display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" },
  modalOptionBtn: { background: "#14171d", border: "1px solid #2a2d34", color: "#e2e8f0", padding: "10px 14px", borderRadius: "6px", fontSize: "13px", fontWeight: "600", textAlign: "left", cursor: "pointer" },
  modalCancelBtn: { background: "transparent", border: "1px solid #2a2d34", color: "#94a3b8", padding: "8px", borderRadius: "6px", fontSize: "12px", width: "100%", cursor: "pointer" },
minimapContainer: {
  position: "absolute",
  right: "20px",
  bottom: "20px",
  width: "280px",
  height: "200px",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: "6px",
  overflow: "hidden",
  background: "#0b0d11",
  boxShadow: "0 6px 18px rgba(0,0,0,0.6)",
  zIndex: 30,
  cursor: "crosshair",
},
  minimapImage: { width: "100%", height: "100%", objectFit: "contain", objectPosition: "center", transform: "scale(1)", display: "block", backgroundColor: "#0b0d11" },
  miniViewportRect: { position: "absolute", border: "2px solid rgba(59,130,246,0.9)", boxSizing: "border-box", pointerEvents: "none", backgroundColor: "rgba(59,130,246,0.08)" },
};