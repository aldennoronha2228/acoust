import { useRef, useState, useEffect, useCallback } from 'react'

// ══════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════
// Preamble: alternating between two tones NOT in the MFSK data band
// This creates a distinctive pattern impossible to confuse with ambient noise
const PRE_TONE_A = 600   // Hz — below baseFreq
const PRE_TONE_B = 800   // Hz — below baseFreq
const PREAMBLE_PAIRS = 3   // 3 A-B alternations = 6 symbol durations

const MAGIC = [0x41, 0x43, 0x53, 0x54]
const TYPE_TEXT = 0x54
const TYPE_IMAGE = 0x49
const HEADER_LEN = 16
const RX_IDLE = 0, RX_SYNC = 1, RX_DATA = 2

// ── Packet helpers ──
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

function playTone(ctx, dest, freq, startTime, duration, gain = 0.4) {
    const osc = ctx.createOscillator()
    const gn = ctx.createGain()
    osc.connect(gn); gn.connect(dest)
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

    // ── Config ──
    const [symDuration, setSymDuration] = useState(120)
    const [baseFreq, setBaseFreq] = useState(1000)
    const [freqSpacing, setFreqSpacing] = useState(200)
    const [imgSize, setImgSize] = useState(48)
    const [threshold, setThreshold] = useState(0.08)
    const [loopback, setLoopback] = useState(false) // route TX directly into RX analyser

    // Refs for stale-closure-safe access inside intervals
    const symDurRef = useRef(symDuration)
    const baseFreqRef = useRef(baseFreq)
    const spacingRef = useRef(freqSpacing)
    const threshRef = useRef(threshold)

    useEffect(() => { symDurRef.current = symDuration }, [symDuration])
    useEffect(() => { baseFreqRef.current = baseFreq }, [baseFreq])
    useEffect(() => { spacingRef.current = freqSpacing }, [freqSpacing])
    useEffect(() => { threshRef.current = threshold }, [threshold])

    const baudRate = Math.round((4 / symDuration) * 1000)

    const getFreqsLive = () =>
        Array.from({ length: 16 }, (_, i) => baseFreqRef.current + i * spacingRef.current)

    const getFreqs = useCallback(() =>
        Array.from({ length: 16 }, (_, i) => baseFreq + i * freqSpacing),
        [baseFreq, freqSpacing]
    )

    // ── TX state ──
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

    // ── RX state ──
    const [isListening, setIsListening] = useState(false)
    const [rxStatus, setRxStatus] = useState({ cls: '', msg: 'MICROPHONE INACTIVE' })
    const [rxOutput, setRxOutput] = useState('—')
    const [rxOutputHas, setRxOutputHas] = useState(false)
    const [decodedBits, setDecodedBits] = useState('')
    const [rxImgProg, setRxImgProg] = useState({ visible: false, pct: 0, label: 'RECEIVING…' })
    const [rxImgSrc, setRxImgSrc] = useState(null)
    const [rxImgStyle, setRxImgStyle] = useState({})
    const [symCells, setSymCells] = useState(Array(16).fill({ hot: false, hottest: false }))
    const [debugInfo, setDebugInfo] = useState({ a: '0.000', b: '0.000', dom: '0.000', state: 'IDLE' })

    // Audio refs
    const rxCanvasRef = useRef(null)
    const sharedCtxRef = useRef(null)   // single AudioContext for loopback; TX ctx otherwise
    const loopTapRef = useRef(null)   // GainNode that TX signals connect to in loopback mode
    const analyserRef = useRef(null)
    const micStreamRef = useRef(null)
    const rxAnimIdRef = useRef(null)
    const sampleIntervalRef = useRef(null)
    const isListeningRef = useRef(false)
    const loopbackRef = useRef(loopback)
    useEffect(() => { loopbackRef.current = loopback }, [loopback])

    // Decode state refs
    const rxStateRef = useRef(RX_IDLE)
    const rxNibblesRef = useRef([])
    const sampleBufRef = useRef([])
    const lastSymTimeRef = useRef(0)
    const silenceCountRef = useRef(0)
    const syncBufRef = useRef([])     // rolling window for chirp detection
    const dataStartAtRef = useRef(0)

    useEffect(() => { isListeningRef.current = isListening }, [isListening])

    const finalizePacketRef = useRef(null)

    // ══════════════════════════════════════════════════════
    // IMAGE UPLOAD
    // ══════════════════════════════════════════════════════
    function compressAndPreview() {
        if (!pendingOrigCanvas.current) return
        const q = jpegQuality / 100
        const dataURL = pendingOrigCanvas.current.toDataURL('image/jpeg', q)
        const b64 = dataURL.split(',')[1]; const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        pendingJpegBytes.current = bytes
        const w = pendingImgW.current, h = pendingImgH.current
        const scale = Math.max(1, Math.floor(120 / Math.max(w, h)))
        setImgPreviewStyle({ width: w * scale, height: h * scale })
        setImgPreviewSrc(dataURL)
        const totalSymbols = Math.ceil((HEADER_LEN + bytes.length) * 2)
        const estSec = ((totalSymbols + PREAMBLE_PAIRS * 2) * symDuration / 1000).toFixed(1)
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
                const size = imgSize; const oc = document.createElement('canvas')
                oc.width = size; oc.height = size
                const ctx = oc.getContext('2d')
                ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
                ctx.drawImage(img, 0, 0, size, size)
                pendingOrigCanvas.current = oc; pendingImgW.current = size; pendingImgH.current = size
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
            const text = txInput; if (!text) return
            payloadBytes = new TextEncoder().encode(text)
            header = buildHeader(TYPE_TEXT, payloadBytes.length)
        } else {
            if (!pendingJpegBytes.current) { setTxStatus({ cls: 'warn', msg: 'NO IMAGE LOADED' }); return }
            payloadBytes = pendingJpegBytes.current
            header = buildHeader(TYPE_IMAGE, payloadBytes.length, pendingImgW.current, pendingImgH.current)
        }

        const fullPacket = new Uint8Array(header.length + payloadBytes.length)
        fullPacket.set(header, 0); fullPacket.set(payloadBytes, header.length)
        const nibbles = bytesToNibbles(fullPacket)

        setTxBusy(true); setTxAnimOn(true)

        // In loopback mode, use the SHARED AudioContext so TX tones go directly to the analyser
        // In normal mode, create a fresh TX AudioContext (tones go to speaker)
        let ctx, dest
        if (loopbackRef.current && sharedCtxRef.current) {
            ctx = sharedCtxRef.current
            dest = loopTapRef.current   // loopback tap → analyser
        } else {
            ctx = new (window.AudioContext || window.webkitAudioContext)()
            dest = ctx.destination      // speaker
        }

        const symS = symDuration / 1000
        let t = ctx.currentTime + 0.05

        // ── Preamble: alternating A-B chirp ──
        // Pattern: A B A B A B (PREAMBLE_PAIRS times)
        for (let i = 0; i < PREAMBLE_PAIRS; i++) {
            playTone(ctx, dest, PRE_TONE_A, t, symS * 0.9, 0.5); t += symS
            playTone(ctx, dest, PRE_TONE_B, t, symS * 0.9, 0.5); t += symS
        }
        t += 0.06  // 60ms guard gap after preamble

        // ── Data symbols ──
        nibbles.forEach(nib => {
            playTone(ctx, dest, freqs[nib], t, symS * 0.88, 0.42)
            t += symS
        })

        const txStart = performance.now() + 50
        const totalMs = (t - ctx.currentTime) * 1000
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
    // RECEIVER
    // ══════════════════════════════════════════════════════
    function getFftMag(freq) {
        const analyser = analyserRef.current
        const rxCtx = sharedCtxRef.current
        if (!analyser || !rxCtx) return 0
        const buf = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(buf)
        const bw = (rxCtx.sampleRate / 2) / analyser.frequencyBinCount
        const bin = Math.round(freq / bw)
        const w = 4; let s = 0
        for (let j = Math.max(0, bin - w); j <= Math.min(buf.length - 1, bin + w); j++) s += buf[j]
        return s / (2 * w + 1) / 255
    }

    function detectDataSymbol() {
        const analyser = analyserRef.current
        const rxCtx = sharedCtxRef.current
        if (!analyser || !rxCtx) return null
        const buf = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(buf)
        const nyq = rxCtx.sampleRate / 2
        const bw = nyq / analyser.frequencyBinCount
        const freqs = getFreqsLive()

        const mags = freqs.map(f => {
            const bin = Math.round(f / bw); const w = 5; let s = 0
            for (let j = Math.max(0, bin - w); j <= Math.min(buf.length - 1, bin + w); j++) s += buf[j]
            return s / (2 * w + 1) / 255
        })
        let bestSym = -1, bestMag = 0
        mags.forEach((m, i) => { if (m > bestMag) { bestMag = m; bestSym = i } })
        return { symbol: bestSym, magnitude: bestMag, mags }
    }

    function resetRxState() {
        rxStateRef.current = RX_IDLE
        rxNibblesRef.current = []
        sampleBufRef.current = []
        silenceCountRef.current = 0
        syncBufRef.current = []
        dataStartAtRef.current = 0
        setRxImgProg({ visible: false, pct: 0, label: 'RECEIVING…' })
    }

    function finalizePacket() {
        const trimNib = rxNibblesRef.current.slice(0, Math.floor(rxNibblesRef.current.length / 2) * 2)
        if (trimNib.length < HEADER_LEN * 2) {
            setRxStatus({ cls: 'warn', msg: `INCOMPLETE — got ${Math.floor(trimNib.length / 2)} bytes` })
            resetRxState()
            setTimeout(() => { if (isListeningRef.current) setRxStatus({ cls: 'info', msg: 'LISTENING — WAITING FOR PREAMBLE…' }) }, 3000)
            return
        }
        const allBytes = nibblesToBytes(trimNib)
        const hdr = parseHeader(allBytes)
        if (!hdr) {
            setRxStatus({ cls: 'warn', msg: 'BAD HEADER — check TX/RX settings match' })
            resetRxState(); return
        }
        const payload = allBytes.slice(HEADER_LEN, HEADER_LEN + hdr.payloadLen)

        if (hdr.type === TYPE_TEXT) {
            const text = new TextDecoder().decode(payload)
            setRxOutput(text); setRxOutputHas(true); setRxImgSrc(null)
            setRxStatus({ cls: 'ok', msg: `✓ RECEIVED: "${text.substring(0, 40)}${text.length > 40 ? '…' : ''}"` })
        } else if (hdr.type === TYPE_IMAGE) {
            const url = URL.createObjectURL(new Blob([payload], { type: 'image/jpeg' }))
            const img = new Image()
            img.onload = () => {
                const scale = Math.max(1, Math.floor(220 / Math.max(img.width, img.height)))
                setRxImgSrc(url); setRxImgStyle({ width: img.width * scale, height: img.height * scale, display: 'block' })
                URL.revokeObjectURL(url)
            }
            img.src = url
            setRxImgProg(p => ({ ...p, visible: false }))
            setRxOutput(`[IMAGE ${hdr.imgW}×${hdr.imgH}px · ${payload.length} bytes]`); setRxOutputHas(true)
            setRxStatus({ cls: 'ok', msg: `✓ IMAGE RECEIVED — ${hdr.imgW}×${hdr.imgH}px` })
        } else {
            setRxStatus({ cls: 'warn', msg: `UNKNOWN TYPE 0x${hdr.type.toString(16)}` })
        }
        resetRxState()
        setTimeout(() => { if (isListeningRef.current) setRxStatus({ cls: 'info', msg: 'LISTENING — WAITING FOR PREAMBLE…' }) }, 3000)
    }

    useEffect(() => { finalizePacketRef.current = finalizePacket })

    function liveUpdateRxImage() {
        if (rxNibblesRef.current.length < HEADER_LEN * 2) return
        const hdr = parseHeader(nibblesToBytes(rxNibblesRef.current.slice(0, HEADER_LEN * 2)))
        if (!hdr || hdr.type !== TYPE_IMAGE) return
        const totalNib = (HEADER_LEN + hdr.payloadLen) * 2
        const pct = Math.min(rxNibblesRef.current.length / totalNib * 100, 100)
        setRxImgProg({ visible: true, pct, label: `RECEIVING IMAGE — ${rxNibblesRef.current.length}/${totalNib} (${pct.toFixed(0)}%)` })
        if (rxNibblesRef.current.length >= totalNib) finalizePacketRef.current?.()
    }

    function startSampling() {
        const sampleMs = Math.max(10, Math.floor(symDurRef.current / 6))

        sampleIntervalRef.current = setInterval(() => {
            const sd = symDurRef.current
            const THRESH = threshRef.current
            const now = performance.now()

            // Read preamble tone magnitudes
            const magA = getFftMag(PRE_TONE_A)
            const magB = getFftMag(PRE_TONE_B)
            const det = detectDataSymbol()
            if (!det) return

            setDebugInfo({ a: magA.toFixed(3), b: magB.toFixed(3), dom: det.magnitude.toFixed(3), state: ['IDLE', 'SYNC', 'DATA'][rxStateRef.current] })

            setSymCells(det.mags.map((m, i) => ({
                hot: m > THRESH * 0.4 && !(i === det.symbol && m > THRESH),
                hottest: i === det.symbol && m > THRESH
            })))

            // ══ STATE MACHINE ══

            if (rxStateRef.current === RX_IDLE) {
                // Detect chirp preamble: both A and B must have been seen strongly
                // We keep a rolling buffer of recent dominant tone detections
                const dominant = magA > magB ? 'A' : 'B'
                if (Math.max(magA, magB) > THRESH) {
                    syncBufRef.current.push(dominant)
                    if (syncBufRef.current.length > 20) syncBufRef.current.shift() // keep last 20

                    // Count alternations in the buffer: ABABAB pattern
                    const buf = syncBufRef.current
                    let alternations = 0
                    for (let i = 1; i < buf.length; i++) if (buf[i] !== buf[i - 1]) alternations++

                    // Need at least 4 alternations (A→B, B→A, A→B, B→A) to confirm chirp
                    if (alternations >= 4 && buf.length >= 6) {
                        rxStateRef.current = RX_SYNC
                        // Timing: preamble lasts PREAMBLE_PAIRS * 2 * symDur from first detection
                        // We detected mid-preamble, so data starts roughly (PREAMBLE_PAIRS * 2 - buf.length/2) symbols from now
                        // Simpler: wait one more full preamble length for safety
                        dataStartAtRef.current = now + (PREAMBLE_PAIRS * 2 * sd) + 80
                        setRxStatus({ cls: 'warn', msg: 'CHIRP DETECTED — SYNCING…' })
                    }
                } else {
                    // No preamble signal: slowly drain the buffer
                    if (syncBufRef.current.length > 0) syncBufRef.current.pop()
                }

            } else if (rxStateRef.current === RX_SYNC) {
                // Purely timing-based: wait until we calculate data starts
                if (now >= dataStartAtRef.current) {
                    rxStateRef.current = RX_DATA
                    rxNibblesRef.current = []
                    sampleBufRef.current = []
                    lastSymTimeRef.current = now
                    silenceCountRef.current = 0
                    setRxStatus({ cls: 'info', msg: 'RECEIVING DATA…' })
                }

            } else if (rxStateRef.current === RX_DATA) {
                // Timeout: 45 seconds max
                if (now - dataStartAtRef.current > 45000) {
                    setRxStatus({ cls: 'warn', msg: 'TIMEOUT — no complete packet' })
                    resetRxState()
                    setTimeout(() => { if (isListeningRef.current) setRxStatus({ cls: 'info', msg: 'LISTENING — WAITING FOR PREAMBLE…' }) }, 2000)
                    return
                }

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
                        rxNibblesRef.current.push(counts.indexOf(Math.max(...counts)))
                        silenceCountRef.current = 0
                        liveUpdateRxImage()
                    } else {
                        silenceCountRef.current++
                        if (silenceCountRef.current >= 5 && rxNibblesRef.current.length >= HEADER_LEN * 2) {
                            finalizePacketRef.current?.(); return
                        }
                        if (silenceCountRef.current >= 12 && rxNibblesRef.current.length === 0) {
                            resetRxState()
                            setRxStatus({ cls: 'info', msg: 'LISTENING — WAITING FOR PREAMBLE…' }); return
                        }
                    }
                    sampleBufRef.current = []; lastSymTimeRef.current = now
                    const nb = rxNibblesRef.current.length
                    setDecodedBits(`SYM: ${nb}  BYTES: ${Math.floor(nb / 2)}  SILENCE: ${silenceCountRef.current}`)
                }
            }
        }, sampleMs)
    }

    // ── Spectrum visualizer ──
    function drawVisualizer() {
        if (!isListeningRef.current) return
        rxAnimIdRef.current = requestAnimationFrame(drawVisualizer)
        const canvas = rxCanvasRef.current; if (!canvas) return
        const ctx = canvas.getContext('2d')
        const W = canvas.width = canvas.offsetWidth * devicePixelRatio
        const H = canvas.height = canvas.offsetHeight * devicePixelRatio
        ctx.clearRect(0, 0, W, H)
        const analyser = analyserRef.current; const rxCtx = sharedCtxRef.current
        if (!analyser || !rxCtx) return

        const buf = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(buf)
        const nyq = rxCtx.sampleRate / 2; const bw = nyq / analyser.frequencyBinCount
        const freqs = getFreqsLive()
        const maxHz = freqs[freqs.length - 1] * 1.3; const binsShow = Math.floor(maxHz / bw)

        ctx.strokeStyle = 'rgba(13,61,90,0.5)'; ctx.lineWidth = 1
        for (let i = 0; i <= 4; i++) { const y = (i / 4) * H; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() }

        const barW = W / binsShow
        for (let i = 0; i < binsShow; i++) {
            const v = buf[i] / 255, h = v * H, hz = i * bw
            let minD = Infinity; freqs.forEach(f => { const d = Math.abs(hz - f); if (d < minD) minD = d })
            const pADist = Math.abs(hz - PRE_TONE_A); const pBDist = Math.abs(hz - PRE_TONE_B)
            let color
            if (pADist < 60 || pBDist < 60) color = `rgba(255,200,50,${0.5 + v * 0.5})`
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
            ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(0,212,255,0.6)'
            ctx.fillText(i.toString(16).toUpperCase(), x + 1, H - 3)
        })
            ;[{ f: PRE_TONE_A, l: 'A' }, { f: PRE_TONE_B, l: 'B' }].forEach(({ f, l }) => {
                const px = (f / maxHz) * W
                ctx.strokeStyle = 'rgba(255,200,50,0.4)'; ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.globalAlpha = 0.5
                ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke()
                ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(255,200,50,0.8)'
                ctx.fillText(l, px + 1, H - 3)
            })
    }

    async function startListening() {
        try {
            let ctx, tap
            if (loopback) {
                // ── Loopback mode: single AudioContext, TX → tap → analyser (no mic!) ──
                ctx = new (window.AudioContext || window.webkitAudioContext)()
                tap = ctx.createGain(); tap.gain.value = 1
                tap.connect(ctx.destination)   // also play through speaker
            } else {
                // ── Acoustic mode: mic → analyser ──
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
                    video: false
                })
                micStreamRef.current = stream
                ctx = new (window.AudioContext || window.webkitAudioContext)()
                tap = ctx.createGain(); tap.gain.value = 0  // tap not used in mic mode, just a dummy
                ctx.createMediaStreamSource(stream).connect(ctx.createAnalyser()) // will be overridden below
            }

            const analyser = ctx.createAnalyser()
            analyser.fftSize = 16384
            analyser.smoothingTimeConstant = 0.1  // very fast response

            if (loopback) {
                tap.connect(analyser)  // TX → tap → analyser
            } else {
                // Reconnect the mic to the analyser
                const stream = micStreamRef.current
                ctx.createMediaStreamSource(stream).connect(analyser)
            }

            sharedCtxRef.current = ctx
            loopTapRef.current = loopback ? tap : null
            analyserRef.current = analyser

            setIsListening(true); isListeningRef.current = true
            setRxStatus({ cls: 'info', msg: loopback ? 'LOOPBACK — READY TO RECEIVE' : 'LISTENING — WAITING FOR PREAMBLE…' })
            resetRxState()
            startSampling()
            requestAnimationFrame(drawVisualizer)
        } catch (e) {
            setRxStatus({ cls: 'warn', msg: 'ERROR: ' + e.message })
        }
    }

    function stopListening() {
        isListeningRef.current = false; setIsListening(false)
        if (micStreamRef.current) micStreamRef.current.getTracks().forEach(t => t.stop())
        if (sharedCtxRef.current) sharedCtxRef.current.close()
        if (rxAnimIdRef.current) cancelAnimationFrame(rxAnimIdRef.current)
        if (sampleIntervalRef.current) clearInterval(sampleIntervalRef.current)
        micStreamRef.current = null; sharedCtxRef.current = null
        loopTapRef.current = null; analyserRef.current = null
        setRxStatus({ cls: '', msg: loopback ? 'LOOPBACK INACTIVE' : 'MICROPHONE INACTIVE' })
        setDebugInfo({ a: '0.000', b: '0.000', dom: '0.000', state: 'IDLE' })
    }

    function toggleListen() { isListening ? stopListening() : startListening() }

    function clearOutput() {
        setRxOutput('—'); setRxOutputHas(false); setDecodedBits('')
        setRxImgSrc(null); setRxImgProg({ visible: false, pct: 0, label: 'RECEIVING…' })
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
                        onChange={e => setSymDuration(+e.target.value)} disabled={isListening} />
                </div>
                <div className="config-item">
                    <label htmlFor="baseFreq">BASE FREQ (Hz)</label>
                    <input id="baseFreq" type="number" value={baseFreq} min="400" max="3000" step="100"
                        onChange={e => setBaseFreq(+e.target.value)} disabled={isListening} />
                </div>
                <div className="config-item">
                    <label htmlFor="freqSpacing">FREQ SPACING (Hz)</label>
                    <input id="freqSpacing" type="number" value={freqSpacing} min="50" max="500" step="50"
                        onChange={e => setFreqSpacing(+e.target.value)} disabled={isListening} />
                </div>
                <div className="config-item">
                    <label htmlFor="imgSize">IMG SIZE (px)</label>
                    <input id="imgSize" type="number" value={imgSize} min="8" max="128" step="8"
                        onChange={e => setImgSize(+e.target.value)} />
                </div>
                <div className="config-item">
                    <label htmlFor="threshold">SENSITIVITY</label>
                    <input id="threshold" type="number" value={threshold} min="0.01" max="0.5" step="0.01"
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
                            <div className={`img-drop${dragOver ? ' drag-over' : ''}`} id="imgDrop"
                                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                                onDragLeave={() => setDragOver(false)}
                                onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) handleImageFile(e.dataTransfer.files[0]) }}>
                                <input type="file" id="imgFileInput" accept="image/*" onChange={e => handleImageFile(e.target.files[0])} />
                                <div className="drop-icon">⬆</div>
                                <div className="drop-label">{dropLabel}</div>
                            </div>
                            <div className="quality-row">
                                <label htmlFor="jpegQuality">JPEG QUALITY</label>
                                <input id="jpegQuality" type="range" min="5" max="95" value={jpegQuality} onChange={e => setJpegQuality(+e.target.value)} />
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

                    {isListening && (
                        <div className="debug-bar">
                            <span>STATE: <em style={{ color: debugInfo.state === 'DATA' ? 'var(--accent3)' : debugInfo.state === 'SYNC' ? 'var(--accent2)' : 'var(--dim)' }}>{debugInfo.state}</em></span>
                            <span>PRE-A: <em style={{ color: +debugInfo.a > threshold ? 'var(--accent3)' : 'var(--dim)' }}>{debugInfo.a}</em></span>
                            <span>PRE-B: <em style={{ color: +debugInfo.b > threshold ? 'var(--accent3)' : 'var(--dim)' }}>{debugInfo.b}</em></span>
                            <span>DATA: <em style={{ color: +debugInfo.dom > threshold ? 'var(--accent)' : 'var(--dim)' }}>{debugInfo.dom}</em></span>
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

                    {/* Loopback toggle */}
                    <div className="loopback-row">
                        <label className="loopback-label" htmlFor="loopbackToggle">
                            <input id="loopbackToggle" type="checkbox" checked={loopback} disabled={isListening}
                                onChange={e => setLoopback(e.target.checked)} />
                            <span>LOOPBACK MODE</span>
                            <span className="loopback-hint">{loopback ? '— TX routes directly to RX (same device, no mic)' : '— uses microphone (separate devices)'}</span>
                        </label>
                    </div>

                    <button id="listenBtn" className={`btn btn-listen${isListening ? ' active' : ''}`} onClick={toggleListen}>
                        {isListening ? '■ STOP' : loopback ? '⬤ START LOOPBACK' : '⬤ START LISTENING'}
                    </button>
                    <div className={`status${rxStatus.cls ? ' ' + rxStatus.cls : ''}`}>{rxStatus.msg}</div>

                    <div className={`rx-img-progress${rxImgProg.visible ? ' visible' : ''}`}>
                        <div className="rx-img-label">{rxImgProg.label}</div>
                        <div className="rx-img-bar-wrap"><div className="rx-img-bar" style={{ width: rxImgProg.pct + '%' }} /></div>
                    </div>

                    {rxImgSrc && (
                        <img id="rxImageCanvas" src={rxImgSrc} alt="received" className="visible"
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
