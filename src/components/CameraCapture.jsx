import React, { useRef, useState, useEffect } from 'react'
import { Camera, Check, RefreshCw, AlertCircle, Upload } from 'lucide-react'

// Camera capture component with graceful fallback for devices without camera.
// Returns a JPEG data URL via onCapture. Does NOT claim biometric/liveness
// verification — it is a functional photo capture only.
export default function CameraCapture({ onCapture }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const [streaming, setStreaming] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [captured, setCaptured] = useState(null)
  const [error, setError] = useState('')

  const startCamera = async () => {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.onloadedmetadata = () => setCameraReady(true)
      }
      setStreaming(true)
    } catch (e) {
      setError(e?.message || 'Camera access was denied or is not available on this device.')
      setStreaming(false)
    }
  }

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    setStreaming(false)
    setCameraReady(false)
  }

  const capture = () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    const w = video.videoWidth || 640
    const h = video.videoHeight || 480
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.translate(w, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0, w, h)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    setCaptured(dataUrl)
    stopCamera()
  }

  const retake = () => {
    setCaptured(null)
    startCamera()
  }

  const confirm = () => {
    onCapture?.(captured)
    stopCamera()
  }

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setCaptured(reader.result)
      setError('')
    }
    reader.readAsDataURL(file)
  }

  useEffect(() => () => stopCamera(), [])

  if (captured) {
    return (
      <div className="space-y-3">
        <img src={captured} alt="Captured selfie" className="w-full max-w-xs rounded-lg border border-slate-300 mx-auto" />
        <div className="flex justify-center gap-2">
          <button type="button" onClick={retake} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
            <RefreshCw className="w-4 h-4" /> Retake
          </button>
          <button type="button" onClick={confirm} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Check className="w-4 h-4" /> Confirm Photo
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm p-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 text-amber-600 mt-0.5" />
          <div>
            <p className="font-medium">Camera not available</p>
            <p className="text-xs mt-0.5">{error} You can upload a photo instead.</p>
          </div>
        </div>
      )}
      <div className="relative bg-slate-900 rounded-lg overflow-hidden" style={{ aspectRatio: '4/3' }}>
        {streaming ? (
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" style={{ transform: 'scaleX(-1)' }} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
            {error ? 'Camera unavailable — use file upload below' : 'Press "Start Camera" to begin'}
          </div>
        )}
        {streaming && cameraReady && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-32 h-32 rounded-full border-2 border-white/50 border-dashed" />
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" />
      <div className="flex flex-col gap-2">
        {!streaming && !error && (
          <button type="button" onClick={startCamera} className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Camera className="w-4 h-4" /> Start Camera
          </button>
        )}
        {streaming && cameraReady && (
          <button type="button" onClick={capture} className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Camera className="w-4 h-4" /> Capture Photo
          </button>
        )}
        {streaming && !cameraReady && (
          <p className="text-center text-sm text-slate-400">Starting camera…</p>
        )}
        {error && (
          <label className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 cursor-pointer">
            <Upload className="w-4 h-4" /> Upload Photo
            <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
          </label>
        )}
      </div>
    </div>
  )
}
