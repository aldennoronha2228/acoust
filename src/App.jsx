import { useRef, useState, useEffect, useCallback } from 'react'

// ══════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════
const PREAMBLE_FREQ = 500
const PREAMBLE_SYMS = 4
const MAGIC = [0x41, 0x43, 0x53, 0x54]
const TYPE_TEXT = 0x54
const TYPE_IMAGE = 0x49
const HEADER_LEN = 16
const RX_IDLE = 0, RX_PREAMBLE = 1, RX_DATA = 2

// ── packet helpers ──
function buildHeader(type, payloadLen, imgW = 0, imgH = 0) {
    const h = new Uint8Array(HEADER_LEN)
    h[0] = MAGIC[0]; h[1] = MAGIC[1]; h[2] = MAGIC[2]; h[3] = MAGIC[3]
    h[4] = type
    h[5] = (payloadLen >> 24) & 0xff; h[6] = (payloadLen >> 16) & 0xff
    h[7] = (payloadLen >> 8) & 0xff; h[8] = payloadLen & 0xff
    h[9] = (imgW >> 8) & 0xff; h[10] = imgW & 0xff
    h[11] = (imgH >> 8) & 0xff; h[12] = imgH & 0xff
    return h
}

function parseHeader(bytes) {
    if (bytes.length < HEADER_LEN) return null
    for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) return null
    const type = bytes[4]
    const payloadLen = (bytes[5] << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8]
    const imgW = (bytes[9] << 8) | bytes[10]
    const imgH = (bytes[11] << 8) | bytes[12]
    return { type, payloadLen, imgW, imgH }
}

function bytesToNibbles(bytes) {
    const out = []
    for (const b of bytes) { out.push((b >> 4) & 0xf); out.push(b & 0xf) }
    return out
}

function nibblesToBytes(nibbles) {
    const out = []
    for (let i = 0; i + 1 < nibbles.length; i += 2)
        out.push(((nibbles[i] & 0xf) << 4) | (nibbles[i + 1] & 0xf))
    return new Uint8Array(out)
}

function playTone(ctx, freq, startTime, duration, gain = 0.4) {
    const osc = ctx.createOscillator()
    const gn = ctx.createGain()
    osc.connect(gn); gn.connect(ctx.destination)
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, startTime)
    gn.gain.setValueAtTime(0, startTime)
    gn.gain.linearRampToValueAtTime(gain, startTime + 0.004)
    gn.gain.setValueAtTime(gain, startTime + duration - 0.006)
    gn.gain.linearRampToValueAtTime(0, startTime + duration)
    osc.start(startTime)
    osc.stop(startTime + duration + 0.01)
}

// ══════════════════════════════════════════════════════════
// APP
// ══════════════════════════════════════════════════════════
export default function App() {

    // ── config ──
    const [symDuration, setSymDuration] = useState(100)   // slightly slower default = more reliable
    const [baseFreq, setBaseFreq] = useState(1000)
    const [freqSpacing, setFreqSpacing] = useState(200)
    const [imgSize, setImgSize] = useState(48)
    const [threshold, setThreshold] = useState(0.05)  // configurable sensitivity

    // Keep config accessible inside intervals via refs (fix for stale-closure bug)
    const symDurRef = useRef(symDuration)
    const baseFreqRef = useRef(baseFreq)
    const spacingRef = useRef(freqSpacing)
    const threshRef = useRef(threshold)

    useEffect(() => { symDurRef.current = symDuration }, [symDuration])
    useEffect(() => { baseFreqRef.current = baseFreq }, [baseFreq])
    useEffect(() => { spacingRef.current = freqSpacing }, [freqSpacing])
    useEffect(() => { threshRef.current = threshold }, [threshold])

    const baudRate = Math.round((4 / symDuration) * 1000)

    const getFreqsFromRefs = () =>
        Array.from({ length: 16 }, (_, i) => baseFreqRef.current + i * spacingRef.current)

    const getFreqs = useCallback(() =>
        Array.from({ length: 16 }, (_, i) => baseFreq + i * freqSpacing),
        [baseFreq, freqSpacing]
    )

    // ── TX ──
    const [txMode, setTxMode] = useState('text')
    const [txInput, setTxInput] = useState('Hello World!')
    const [txStatus, setTxStatus] = useState({ cls: '', msg: 'READY — MFSK-16 MODE' })
    const [txProgress, setTxProgress] = useState(0)
    const [txBusy, setTxBusy] = useState(false)
    const [txAnimOn, setTxAnimOn] = useState(false)
    const [dragOver, setDragOver] = useState(false)
    const [jpegQuality, setJpegQuality] = useState(40)
    const [dropLabel, setDropLabel] = useState('DROP IMAGE · CLICK TO BROWSE\nAuto-compressed to JPEG before transmit')
    const [imgPreviewSrc, setImgPreviewSrc] = useState(null)
    const [imgPreviewStyle, setImgPreviewStyle] = useState({})
    const [imgMeta, setImgMeta] = useState(null)

    const pendingJpegBytes = useRef(null)
    const pendingOrigCanvas = useRef(null)
    const pendingImgW = useRef(0)
    const pendingImgH = useRef(0)
    const txCtxRef = useRef(null)

    // ── RX UI state ──
    const [isListening, setIsListening] = useState(false)
    const [rxStatus, setRxStatus] = useState({ cls: '', msg: 'MICROPHONE INACTIVE' })
    const [rxOutput, setRxOutput] = useState('—')
    const [rxOutputHas, setRxOutputHas] = useState(false)
    const [decodedBits, setDecodedBits] = useState('')
    const [rxImgProg, setRxImgProg] = useState({ visible: false, pct: 0, label: 'RECEIVING…' })
    const [rxImgSrc, setRxImgSrc] = useState(null)
    const [rxImgStyle, setRxImgStyle] = useState({})
    const [symCells, setSymCells] = useState(Array(16).fill({ hot: false, hottest: false }))
    const [debugMag, setDebugMag] = useState({ pre: 0, dom: 0 }) // live magnitude display

    // ── RX audio refs ──
    const rxCanvasRef = useRef(null)
    const rxCtxRef = useRef(null)
    const analyserRef = useRef(null)
    const micStreamRef = useRef(null)
    const rxAnimIdRef = useRef(null)
    const sampleIntervalRef = useRef(null)
    const isListeningRef = useRef(false)

    // ── RX decode state (ALWAYS use refs, never stale closures) ──
    const rxStateRef = useRef(RX_IDLE)
    const rxNibblesRef = useRef([])
    const sampleBufRef = useRef([])
    const lastSymTimeRef = useRef(0)
    const preambleAtRef = useRef(0)
    const silenceCountRef = useRef(0)

    useEffect(() => { isListeningRef.current = isListening }, [isListening])

    // ══════════════════════════════════════════════════════
    // IMAGE UPLOAD
    // ══════════════════════════════════════════════════════
    function compressAndPreview() {
        if (!pendingOrigCanvas.current) return
        const q = jpegQuality / 100
        const dataURL = pendingOrigCanvas.current.toDataURL('image/jpeg', q)
        const b64 = dataURL.split(',')[1]
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        pendingJpegBytes.current = bytes

        const w = pendingImgW.current, h = pendingImgH.current
        const scale = Math.max(1, Math.floor(120 / Math.max(w, h)))
        setImgPreviewStyle({ width: w * scale, height: h * scale })
        setImgPreviewSrc(dataURL)

        const totalSymbols = Math.ceil((HEADER_LEN + bytes.length) * 2)
        const estSec = ((totalSymbols + PREAMBLE_SYMS) * symDuration / 1000).toFixed(1)
        setImgMeta({ w, h, bytes: bytes.length, totalSymbols, estSec })
        setDropLabel('IMAGE LOADED — DROP NEW TO REPLACE')
    }

    useEffect(() => { compressAndPreview() }, [jpegQuality]) // eslint-disable-line

    function handleImageFile(file) {
        if (!file) return
        const reader = new FileReader()
        reader.onload = e => {
            const img = new Image()
            img.onload = () => {
                const size = imgSize
                const oc = document.createElement('canvas')
                oc.width = size; oc.height = size
                const ctx = oc.getContext('2d')
                ctx.imageSmoothingEnabled = true
                ctx.imageSmoothingQuality = 'high'
                ctx.drawImage(img, 0, 0, size, size)
                pendingOrigCanvas.current = oc
                pendingImgW.current = size
                pendingImgH.current = size
                compressAndPreview()
            }
            img.src = e.target.result
        }
        reader.readAsDataURL(file)
    }

    // ══════════════════════════════════════════════════════
    // TRANSMIT
    // ══════════════════════════════════════════════════════
    async function transmit() {
        const freqs = getFreqs()
        let payloadBytes, header

        if (txMode === 'text') {
            const text = txInput
            if (!text) return
            payloadBytes = new TextEncoder().encode(text)
            header = buildHeader(TYPE_TEXT, payloadBytes.length)
        } else {
            if (!pendingJpegBytes.current) {
                setTxStatus({ cls: 'warn', msg: 'NO IMAGE LOADED' }); return
            }
            payloadBytes = pendingJpegBytes.current
            header = buildHeader(TYPE_IMAGE, payloadBytes.length, pendingImgW.current, pendingImgH.current)
        }

        const fullPacket = new Uint8Array(header.length + payloadBytes.length)
        fullPacket.set(header, 0); fullPacket.set(payloadBytes, header.length)
        const nibbles = bytesToNibbles(fullPacket)

        setTxBusy(true); setTxAnimOn(true)
        txCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
        const symS = symDuration / 1000
        let t = txCtxRef.current.currentTime + 0.05

        playTone(txCtxRef.current, PREAMBLE_FREQ, t, symS * PREAMBLE_SYMS, 0.5)
        t += symS * PREAMBLE_SYMS + 0.04 // slightly longer gap after preamble

        nibbles.forEach(nib => {
            playTone(txCtxRef.current, freqs[nib], t, symS * 0.92, 0.4)
            t += symS
        })

        const txStart = performance.now() + 50
        const totalMs = (t - txCtxRef.current.currentTime) * 1000
        setTxStatus({ cls: 'warn', msg: `TRANSMITTING ${nibbles.length} SYMBOLS…` })

        const anim = () => {
            const frac = Math.min((performance.now() - txStart) / totalMs, 1)
            setTxProgress(frac * 100)
            if (frac < 1) requestAnimationFrame(anim)
            else {
                setTxStatus({ cls: 'ok', msg: `DONE — ${nibbles.length} SYMBOLS · ${fullPacket.length} BYTES` })
                setTxBusy(false); setTxAnimOn(false)
            }
        }
        requestAnimationFrame(anim)
    }

    // ══════════════════════════════════════════════════════
    // RECEIVER — all functions use refs, no stale closures
    // ══════════════════════════════════════════════════════
    function resetRxState() {
        rxStateRef.current = RX_IDLE
        rxNibblesRef.current = []
        sampleBufRef.current = []
        preambleAtRef.current = 0
        silenceCountRef.current = 0
        setRxImgProg({ visible: false, pct: 0, label: 'RECEIVING…' })
    }

    // Read FFT magnitudes for each of the 16 MFSK tones using CURRENT refs
    function detectSymbol() {
        const analyser = analyserRef.current
        const rxCtx = rxCtxRef.current
        if (!analyser || !rxCtx) return null
        const buf = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(buf)
        const nyq = rxCtx.sampleRate / 2
        const bw = nyq / analyser.frequencyBinCount
        const freqs = getFreqsFromRefs()  // ← uses refs, always current

        const mags = freqs.map(f => {
            const bin = Math.round(f / bw)
            const w = 5; let s = 0  // wider window for better sensitivity
            for (let j = Math.max(0, bin - w); j <= Math.min(buf.length - 1, bin + w); j++) s += buf[j]
            return s / (2 * w + 1) / 255
        })
        let bestSym = -1, bestMag = 0
        mags.forEach((m, i) => { if (m > bestMag) { bestMag = m; bestSym = i } })
        return { symbol: bestSym, magnitude: bestMag, mags }
    }

    function getPreambleMag() {
        const analyser = analyserRef.current
        const rxCtx = rxCtxRef.current
        if (!analyser || !rxCtx) return 0
        const buf = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(buf)
        const bw = (rxCtx.sampleRate / 2) / analyser.frequencyBinCount
        const bin = Math.round(PREAMBLE_FREQ / bw)
        let s = 0; const w = 5  // wider window
        for (let j = Math.max(0, bin - w); j <= Math.min(buf.length - 1, bin + w); j++) s += buf[j]
        return s / (2 * w + 1) / 255
    }

    // Use a ref for finalizePacket so it's always the latest version inside interval
    const finalizePacketRef = useRef(null)

    function finalizePacket() {
        const trimNib = rxNibblesRef.current.slice(0, Math.floor(rxNibblesRef.current.length / 2) * 2)
        if (trimNib.length < HEADER_LEN * 2) {
            setRxStatus({ cls: 'warn', msg: `INCOMPLETE — only ${trimNib.length / 2} bytes` })
            resetRxState()
            setTimeout(() => {
                if (isListeningRef.current) setRxStatus({ cls: 'info', msg: 'LISTENING — WAITING FOR PREAMBLE…' })
            }, 3000)
            return
        }
        const allBytes = nibblesToBytes(trimNib)
        const hdr = parseHeader(allBytes)
        if (!hdr) {
            setRxStatus({ cls: 'warn', msg: 'BAD HEADER — check settings match TX' })
            resetRxState(); return
        }

        const payload = allBytes.slice(HEADER_LEN, HEADER_LEN + hdr.payloadLen)

        if (hdr.type === TYPE_TEXT) {
            const text = new TextDecoder().decode(payload)
            setRxOutput(text); setRxOutputHas(true)
            setRxImgSrc(null)
            setRxStatus({ cls: 'ok', msg: `✓ TEXT RECEIVED — ${payload.length} bytes` })
        } else if (hdr.type === TYPE_IMAGE) {
            const blob = new Blob([payload], { type: 'image/jpeg' })
            const url = URL.createObjectURL(blob)
            const img = new Image()
            img.onload = () => {
                const scale = Math.max(1, Math.floor(220 / Math.max(img.width, img.height)))
                setRxImgSrc(url)
                setRxImgStyle({ width: img.width * scale, height: img.height * scale, display: 'block' })
                URL.revokeObjectURL(url)
            }
            img.src = url
            setRxImgProg(p => ({ ...p, visible: false }))
            setRxOutput(`[IMAGE ${hdr.imgW}×${hdr.imgH}px · ${payload.length} bytes]`)
            setRxOutputHas(true)
            setRxStatus({ cls: 'ok', msg: `✓ IMAGE RECEIVED — ${hdr.imgW}×${hdr.imgH}px` })
        } else {
            setRxStatus({ cls: 'warn', msg: `UNKNOWN TYPE 0x${hdr.type.toString(16)}` })
        }
        resetRxState()
        setTimeout(() => {
            if (isListeningRef.current) setRxStatus({ cls: 'info', msg: 'LISTENING — WAITING FOR PREAMBLE…' })
        }, 4000)
    }

    // Keep ref in sync so setInterval always calls the latest version
    useEffect(() => { finalizePacketRef.current = finalizePacket }) // runs every render

    function liveUpdateRxImage() {
        if (rxNibblesRef.current.length < HEADER_LEN * 2) return
        const hdr = parseHeader(nibblesToBytes(rxNibblesRef.current.slice(0, HEADER_LEN * 2)))
        if (!hdr || hdr.type !== TYPE_IMAGE) return
        const totalNibbles = (HEADER_LEN + hdr.payloadLen) * 2
        const pct = Math.min(rxNibblesRef.current.length / totalNibbles * 100, 100)
        setRxImgProg({
            visible: true, pct,
            label: `RECEIVING IMAGE — ${rxNibblesRef.current.length}/${totalNibbles} (${pct.toFixed(0)}%)`
        })
        if (rxNibblesRef.current.length >= totalNibbles) finalizePacketRef.current?.()
    }

    function startSampling() {
        // sampleMs comes from ref so it uses the value when sampling started — that's fine
        const sampleMs = Math.max(15, Math.floor(symDurRef.current / 4))

        sampleIntervalRef.current = setInterval(() => {
            // ↓ Read EVERYTHING from refs — zero stale-closure risk
            const sd = symDurRef.current
            const THRESH = threshRef.current
            const now = performance.now()
            const mp = getPreambleMag()
            const det = detectSymbol()
            if (!det) return

            // Update debug display every tick
            setDebugMag({ pre: mp.toFixed(3), dom: det.magnitude.toFixed(3) })

            // Update symbol grid
            setSymCells(det.mags.map((m, i) => ({
                hot: m > THRESH * 0.4 && !(i === det.symbol && m > THRESH),
                hottest: i === det.symbol && m > THRESH
            })))

            // ── STATE MACHINE ──
            if (rxStateRef.current === RX_IDLE) {
                // FIX: preamble just needs to be above threshold AND dominant among all measured signals
                // Removed the strict "1.2×" multiplier — in practice mic audio is not that clean
                if (mp > THRESH) {
                    if (!preambleAtRef.current) preambleAtRef.current = now
                    if (now - preambleAtRef.current > sd * 1.2) {  // need 1.2 symbols of preamble
                        rxStateRef.current = RX_PREAMBLE
                        setRxStatus({ cls: 'warn', msg: 'PREAMBLE DETECTED — INCOMING…' })
                    }
                } else {
                    preambleAtRef.current = 0
                }

            } else if (rxStateRef.current === RX_PREAMBLE) {
                // FIX: only wait for preamble to fade — don't require data silence simultaneously
                // This fixes the race condition where we'd miss the first data symbol
                if (mp < THRESH * 0.5) {
                    rxStateRef.current = RX_DATA
                    rxNibblesRef.current = []
                    sampleBufRef.current = []
                    lastSymTimeRef.current = now
                    silenceCountRef.current = 0
                    setRxStatus({ cls: 'info', msg: 'RECEIVING DATA…' })
                }

            } else if (rxStateRef.current === RX_DATA) {
                if (det.magnitude > THRESH) {
                    sampleBufRef.current.push(det.symbol)
                    silenceCountRef.current = 0
                } else {
                    sampleBufRef.current.push(null)
                }

                if (now - lastSymTimeRef.current >= sd) {
                    const valid = sampleBufRef.current.filter(x => x !== null)
                    if (valid.length > 0) {
                        const counts = new Array(16).fill(0)
                        valid.forEach(s => counts[s]++)
                        const winner = counts.indexOf(Math.max(...counts))
                        rxNibblesRef.current.push(winner)
                        silenceCountRef.current = 0
                        liveUpdateRxImage()
                    } else {
                        silenceCountRef.current++
                        // FIX: 6 silent windows (was 4) + must have at least a full header worth of data
                        if (silenceCountRef.current >= 6 && rxNibblesRef.current.length >= HEADER_LEN * 2) {
                            finalizePacketRef.current?.(); return
                        }
                    }
                    sampleBufRef.current = []
                    lastSymTimeRef.current = now
                    setDecodedBits(
                        `SYM: ${rxNibblesRef.current.length}  BYTES: ${Math.floor(rxNibblesRef.current.length / 2)}`
                    )
                }
            }
        }, sampleMs)
    }

    // ── Visualizer (uses refs, safe to call recursively) ──
    function drawVisualizer() {
        if (!isListeningRef.current) return
        rxAnimIdRef.current = requestAnimationFrame(drawVisualizer)
        const canvas = rxCanvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        const W = canvas.width = canvas.offsetWidth * devicePixelRatio
        const H = canvas.height = canvas.offsetHeight * devicePixelRatio
        ctx.clearRect(0, 0, W, H)
        const analyser = analyserRef.current
        const rxCtx = rxCtxRef.current
        if (!analyser || !rxCtx) return

        const buf = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(buf)
        const nyq = rxCtx.sampleRate / 2
        const bw = nyq / analyser.frequencyBinCount
        const freqs = getFreqsFromRefs()
        const maxHz = freqs[freqs.length - 1] * 1.3
        const binsShow = Math.floor(maxHz / bw)

        ctx.strokeStyle = 'rgba(13,61,90,0.5)'; ctx.lineWidth = 1
        for (let i = 0; i <= 4; i++) {
            const y = (i / 4) * H
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
        }

        const barW = W / binsShow
        for (let i = 0; i < binsShow; i++) {
            const v = buf[i] / 255, h = v * H, hz = i * bw
            let minD = Infinity
            freqs.forEach(f => { const d = Math.abs(hz - f); if (d < minD) minD = d })
            const pDist = Math.abs(hz - PREAMBLE_FREQ)
            let color
            if (pDist < 80) color = `rgba(255,200,50,${0.5 + v * 0.5})`
            else if (minD < 80) color = `rgba(0,212,255,${0.4 + v * 0.6})`
            else color = `rgba(20,80,100,${0.25 + v * 0.4})`
            ctx.fillStyle = color
            ctx.fillRect(i * barW, H - h, Math.max(barW - 0.3, 1), h)
        }

        ctx.font = `${7 * devicePixelRatio}px Share Tech Mono`
        freqs.forEach((f, i) => {
            const x = (f / maxHz) * W
            ctx.strokeStyle = 'rgba(0,212,255,0.3)'; ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.globalAlpha = 0.5
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
            ctx.setLineDash([]); ctx.globalAlpha = 1
            ctx.fillStyle = 'rgba(0,212,255,0.6)'
            ctx.fillText(i.toString(16).toUpperCase(), x + 1, H - 3)
        })

        const px = (PREAMBLE_FREQ / maxHz) * W
        ctx.strokeStyle = 'rgba(255,200,50,0.4)'; ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.globalAlpha = 0.5
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke()
        ctx.setLineDash([]); ctx.globalAlpha = 1
        ctx.fillStyle = 'rgba(255,200,50,0.8)'
        ctx.fillText('P', px + 1, H - 3)
    }

    async function startListening() {
        try {
            micStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
            rxCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
            analyserRef.current = rxCtxRef.current.createAnalyser()
            analyserRef.current.fftSize = 16384
            analyserRef.current.smoothingTimeConstant = 0.2  // less smoothing = faster response
            rxCtxRef.current.createMediaStreamSource(micStreamRef.current).connect(analyserRef.current)
            setIsListening(true)
            isListeningRef.current = true
            setRxStatus({ cls: 'info', msg: 'LISTENING — WAITING FOR PREAMBLE…' })
            resetRxState()
            startSampling()
            requestAnimationFrame(drawVisualizer)
        } catch (e) {
            setRxStatus({ cls: 'warn', msg: 'MIC ERROR: ' + e.message })
        }
    }

    function stopListening() {
        isListeningRef.current = false
        setIsListening(false)
        if (micStreamRef.current) micStreamRef.current.getTracks().forEach(t => t.stop())
        if (rxCtxRef.current) rxCtxRef.current.close()
        if (rxAnimIdRef.current) cancelAnimationFrame(rxAnimIdRef.current)
        if (sampleIntervalRef.current) clearInterval(sampleIntervalRef.current)
        setRxStatus({ cls: '', msg: 'MICROPHONE INACTIVE' })
        setDebugMag({ pre: 0, dom: 0 })
    }

    function toggleListen() { isListening ? stopListening() : startListening() }

    function clearOutput() {
        setRxOutput('—'); setRxOutputHas(false)
        setDecodedBits('')
        setRxImgSrc(null)
        setRxImgProg({ visible: false, pct: 0, label: 'RECEIVING…' })
        resetRxState()
    }

    useEffect(() => () => { stopListening() }, []) // eslint-disable-line

    // ══════════════════════════════════════════════════════
    // RENDER
    // ══════════════════════════════════════════════════════
    return (
        <>
            <header className="header">
                <h1 className="logo">ACOUST</h1>
                <div className="tagline">MFSK-16 · 4 bits per symbol · Acoustic Data Modem</div>
                <div className="speed-badge">⚡ 4× FASTER THAN BFSK</div>
            </header>

            <div className="config-bar">
                <div className="config-item">
                    <label htmlFor="symDuration">SYMBOL DURATION (ms)</label>
                    <input id="symDuration" type="number" value={symDuration} min="30" max="400" step="10"
                        onChange={e => setSymDuration(+e.target.value)} />
                </div>
                <div className="config-item">
                    <label htmlFor="baseFreq">BASE FREQ (Hz)</label>
                    <input id="baseFreq" type="number" value={baseFreq} min="400" max="3000" step="100"
                        onChange={e => setBaseFreq(+e.target.value)} />
                </div>
                <div className="config-item">
                    <label htmlFor="freqSpacing">FREQ SPACING (Hz)</label>
                    <input id="freqSpacing" type="number" value={freqSpacing} min="50" max="500" step="50"
                        onChange={e => setFreqSpacing(+e.target.value)} />
                </div>
                <div className="config-item">
                    <label htmlFor="imgSize">IMG SIZE (px)</label>
                    <input id="imgSize" type="number" value={imgSize} min="8" max="128" step="8"
                        onChange={e => setImgSize(+e.target.value)} />
                </div>
                <div className="config-item">
                    <label htmlFor="threshold">SENSITIVITY</label>
                    <input id="threshold" type="number" value={threshold} min="0.01" max="0.2" step="0.01"
                        onChange={e => setThreshold(+e.target.value)} />
                </div>
                <div className="baud-display">{baudRate} bps</div>
            </div>

            <main className="main">

                {/* ══ SENDER ══ */}
                <section className="panel panel-sender">
                    <div className="corner-deco tl" /><div className="corner-deco tr" />
                    <div className="corner-deco bl" /><div className="corner-deco br" />
                    <div className="panel-title"><span className="dot" />TX — TRANSMITTER</div>

                    <div className="mode-tabs">
                        <button className={`tab-btn${txMode === 'text' ? ' active' : ''}`} id="tabText" onClick={() => setTxMode('text')}>◈ TEXT</button>
                        <button className={`tab-btn${txMode === 'image' ? ' active' : ''}`} id="tabImage" onClick={() => setTxMode('image')}>◧ IMAGE</button>
                    </div>

                    {txMode === 'text' && (
                        <div id="textMode">
                            <div className="section-label">Message Input</div>
                            <textarea id="txInput" rows="4" placeholder="Enter message to transmit..."
                                value={txInput} onChange={e => setTxInput(e.target.value)} />
                        </div>
                    )}

                    {txMode === 'image' && (
                        <div id="imageMode">
                            <div className="section-label">Image Upload (JPEG compressed before TX)</div>
                            <div
                                className={`img-drop${dragOver ? ' drag-over' : ''}`}
                                id="imgDrop"
                                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                                onDragLeave={() => setDragOver(false)}
                                onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) handleImageFile(e.dataTransfer.files[0]) }}
                            >
                                <input type="file" id="imgFileInput" accept="image/*" onChange={e => handleImageFile(e.target.files[0])} />
                                <div className="drop-icon">⬆</div>
                                <div className="drop-label">{dropLabel}</div>
                            </div>
                            <div className="quality-row">
                                <label htmlFor="jpegQuality">JPEG QUALITY</label>
                                <input id="jpegQuality" type="range" min="5" max="95" value={jpegQuality}
                                    onChange={e => setJpegQuality(+e.target.value)} />
                                <span className="qval">{jpegQuality}%</span>
                            </div>
                            {imgPreviewSrc && (
                                <div className="img-preview-wrap visible">
                                    <img src={imgPreviewSrc} alt="preview"
                                        style={{ ...imgPreviewStyle, imageRendering: 'pixelated', border: '1px solid var(--accent2)', boxShadow: '0 0 8px rgba(255,107,53,0.2)' }} />
                                    {imgMeta && (
                                        <div className="img-meta">
                                            SIZE: <span>{imgMeta.w}×{imgMeta.h}px</span><br />
                                            JPEG: <span className="fast">{imgMeta.bytes} bytes</span><br />
                                            SYMBOLS: <span>{imgMeta.totalSymbols}</span><br />
                                            EST TIME: <span className="fast">~{imgMeta.estSec}s</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    <button id="txBtn" className="btn btn-transmit" onClick={transmit} disabled={txBusy}>▶ TRANSMIT</button>
                    <div className={`tx-anim${txAnimOn ? ' on' : ''}`} />
                    <div className="progress-wrap"><div className="progress-bar" style={{ width: txProgress + '%' }} /></div>
                    <div className={`status${txStatus.cls ? ' ' + txStatus.cls : ''}`}>{txStatus.msg}</div>
                </section>

                {/* ══ RECEIVER ══ */}
                <section className="panel panel-receiver">
                    <div className="corner-deco tl" /><div className="corner-deco tr" />
                    <div className="corner-deco bl" /><div className="corner-deco br" />
                    <div className="panel-title"><span className="dot" />RX — RECEIVER</div>

                    <canvas id="rxCanvas" ref={rxCanvasRef} />

                    {/* Debug magnitude display — helps user tune sensitivity */}
                    {isListening && (
                        <div className="debug-bar">
                            <span>PREAMBLE: <em style={{ color: +debugMag.pre > threshold ? 'var(--accent3)' : 'var(--dim)' }}>{debugMag.pre}</em></span>
                            <span>DOMINANT: <em style={{ color: +debugMag.dom > threshold ? 'var(--accent)' : 'var(--dim)' }}>{debugMag.dom}</em></span>
                            <span style={{ color: 'var(--dim)' }}>THRESH: {threshold}</span>
                        </div>
                    )}

                    <div className="symbol-grid" id="symbolGrid">
                        {symCells.map((c, i) => (
                            <div key={i} id={`sym${i}`} className={`sym-cell${c.hottest ? ' hottest' : c.hot ? ' hot' : ''}`}>
                                {i.toString(16).toUpperCase()}
                            </div>
                        ))}
                    </div>

                    <button id="listenBtn" className={`btn btn-listen${isListening ? ' active' : ''}`} onClick={toggleListen}>
                        {isListening ? '■ STOP LISTENING' : '⬤ START LISTENING'}
                    </button>
                    <div className={`status${rxStatus.cls ? ' ' + rxStatus.cls : ''}`}>{rxStatus.msg}</div>

                    <div className={`rx-img-progress${rxImgProg.visible ? ' visible' : ''}`}>
                        <div className="rx-img-label">{rxImgProg.label}</div>
                        <div className="rx-img-bar-wrap"><div className="rx-img-bar" style={{ width: rxImgProg.pct + '%' }} /></div>
                    </div>

                    {rxImgSrc && (
                        <img id="rxImageCanvas" src={rxImgSrc} alt="received"
                            className="visible"
                            style={{ ...rxImgStyle, imageRendering: 'pixelated', border: '1px solid var(--accent3)', boxShadow: '0 0 12px rgba(57,255,20,0.2)', marginTop: 12 }} />
                    )}

                    <div className="section-label">
                        Decoded Output <button className="clear-btn" onClick={clearOutput}>[ CLEAR ]</button>
                    </div>
                    <div className={`output-area${rxOutputHas ? ' has-content' : ''}`}>{rxOutput}</div>
                    <div className="status" style={{ marginTop: 6 }}>{decodedBits}</div>
                </section>
            </main>

            <footer className="footer">
                ACOUST · MFSK-16 ACOUSTIC MODEM · OPEN SOURCE ·{' '}
                <a href="https://github.com/aldennoronha2228/acoust" target="_blank" rel="noreferrer">GITHUB</a>
            </footer>
        </>
    )
}
