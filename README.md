# ACOUST — MFSK-16 Acoustic Data Modem

> **Transfer text and images between devices using nothing but sound.**

![ACOUST Banner](https://img.shields.io/badge/ACOUST-MFSK--16%20Acoustic%20Modem-00d4ff?style=for-the-badge&labelColor=050a0e)
![Vite](https://img.shields.io/badge/Vite-6.x-646cff?style=for-the-badge&logo=vite&logoColor=white)
![React](https://img.shields.io/badge/React-18.x-61dafb?style=for-the-badge&logo=react&logoColor=black)
![Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-39ff14?style=for-the-badge)

---

## 🔊 What Is ACOUST?

**ACOUST** is a browser-based acoustic data modem that encodes digital data into audible sound tones and decodes them back — all in real time, entirely in your browser using the **Web Audio API**.

No Wi-Fi. No Bluetooth. No cables. No servers. Just sound.

It uses **MFSK-16** (Multiple Frequency Shift Keying with 16 tones), a robust digital modulation scheme that transmits **4 bits per audio symbol** — making it **4× faster than basic BFSK** modems. You can send text messages or JPEG-compressed images from one device to another simply by playing audio through a speaker and capturing it with a microphone.

---

## ✨ Features

| Feature | Details |
|---|---|
| **Modulation** | MFSK-16 — 16 simultaneous frequency bands |
| **Data rate** | Configurable; ~50 bps at default settings (80ms symbols) |
| **Text transfer** | Encode any UTF-8 string into sound and decode it |
| **Image transfer** | JPEG-compress images and transmit them acoustically |
| **Real-time visualizer** | Live FFT spectrum display of all 16 MFSK channels |
| **16-symbol grid** | Real-time hex display showing which frequency is active |
| **Packet framing** | Custom binary packet format with magic header + CRC-free parity |
| **Preamble detection** | Dedicated 500 Hz preamble tone for receiver sync |
| **Majority-vote decoder** | Noise-robust symbol decoding using vote accumulation |
| **JPEG compression** | Configurable quality slider (5–95%) before transmission |
| **Drag & Drop** | Drop images directly onto the upload zone |
| **Zero dependencies** | Pure Web Audio API + Web APIs — no backend required |

---

## 🏗️ How It Works

### The Modulation: MFSK-16

MFSK stands for **Multiple Frequency Shift Keying**. In MFSK-16, 16 distinct audio frequencies are used — each representing a 4-bit value (a "nibble", 0–15 in hexadecimal).

```
Symbol 0  →  baseFreq + 0  × spacing   (e.g. 1000 Hz)
Symbol 1  →  baseFreq + 1  × spacing   (e.g. 1200 Hz)
Symbol 2  →  baseFreq + 2  × spacing   (e.g. 1400 Hz)
...
Symbol F  →  baseFreq + 15 × spacing   (e.g. 4000 Hz)
```

Each byte of data is split into two nibbles (high 4 bits, low 4 bits), and each nibble is transmitted as a single tone burst lasting one **symbol duration** (default: 80ms).

### The Packet Format

Every transmission is wrapped in a 16-byte binary header followed by the payload:

```
Offset   Field           Size    Description
------   -----           ----    -----------
0–3      Magic           4 B     0x41 0x43 0x53 0x54  ("ACST")
4        Type            1 B     0x54 = TEXT, 0x49 = IMAGE
5–8      Payload length  4 B     Big-endian uint32
9–10     Image width     2 B     Pixels (0 for text)
11–12    Image height    2 B     Pixels (0 for text)
13–15    Reserved        3 B     Future use / padding
--- payload starts at byte 16 ---
```

### Transmission Flow

```
[ Raw Data (text/JPEG bytes) ]
        ↓
[ Prepend 16-byte header ]
        ↓
[ Split every byte into 2 nibbles ]
        ↓
[ Preamble: 500 Hz tone for ~320ms ]        ← sync signal
        ↓
[ For each nibble: play tone at freqs[nibble] for symDuration ms ]
        ↓
[ Speaker → Air → Microphone ]
```

### Reception & Decoding Flow

```
[ Microphone audio stream ]
        ↓
[ Web Audio API AnalyserNode (FFT size: 16384) ]
        ↓
[ Poll every symDuration/4 ms — detect preamble 500 Hz tone ]
        ↓
[ Preamble detected → switch to DATA receive mode ]
        ↓
[ For each symbol window: sample FFT multiple times → majority vote ]
        ↓
[ Accumulate nibbles → reassemble bytes ]
        ↓
[ Parse 16-byte header → validate magic bytes ]
        ↓
[ Decode payload as UTF-8 text or JPEG image ]
```

### Majority-Vote Decoding

Within each symbol window the receiver polls the FFT approximately **4× per symbol duration**. It accumulates all samples taken within that window, then picks the frequency that appeared most often (majority vote). This makes the decoder robust against brief noise spikes that would otherwise corrupt a sample.

### Preamble Synchronisation

A dedicated **500 Hz tone** (below the data frequency band, which starts at 1000 Hz by default) is played for the duration of `PREAMBLE_SYMS × symDuration` before any data. The receiver idles looking for this tone. When the preamble fades, it transitions into DATA receive mode.

### Image Transmission

Images are:
1. Downscaled to `imgSize × imgSize` pixels (default 48×48) using canvas `drawImage`
2. JPEG-compressed in-browser using `canvas.toDataURL('image/jpeg', quality)` 
3. The JPEG byte stream is encoded into nibbles and transmitted like any other payload
4. On the receiver side, the raw JPEG bytes are reconstructed and decoded via a `Blob` URL into an `<img>` element

---

## ⚙️ Configuration Parameters

| Parameter | Default | Range | Effect |
|---|---|---|---|
| **Symbol Duration** | 80 ms | 30–400 ms | Lower = faster but needs cleaner audio channel |
| **Base Frequency** | 1000 Hz | 400–3000 Hz | Starting frequency of the 16-tone ladder |
| **Freq Spacing** | 200 Hz | 50–500 Hz | Gap between adjacent tones; wider = easier to discriminate |
| **Image Size** | 48 px | 8–128 px | Square dimension images are resized to before JPEG encode |
| **JPEG Quality** | 40% | 5–95% | Higher quality = more bytes = longer transmission time |

### Baud Rate Formula

```
baud_rate (bps) = floor(4 / symDuration_ms × 1000)

Default:  floor(4 / 80 × 1000) = 50 bps
Fastest:  floor(4 / 30 × 1000) = 133 bps
```

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- npm v9 or higher
- A modern browser (Chrome, Edge, Firefox, Safari) with microphone permission

### Local Development

```bash
# 1. Clone the repository
git clone https://github.com/aldennoronha2228/acoust.git
cd acoust

# 2. Install dependencies
npm install

# 3. Start the dev server
npm run dev
```

Open **http://localhost:5173** in your browser.

### Production Build

```bash
npm run build
# Output is in the /dist directory
```

---

## ☁️ Deploying to Vercel

### Option 1 — Vercel Dashboard (recommended)

1. Push this repository to GitHub
2. Go to [vercel.com](https://vercel.com) → **New Project**
3. Import your GitHub repo
4. Vercel auto-detects Vite — click **Deploy**
5. Your site is live at `https://your-project.vercel.app` 🎉

### Option 2 — Vercel CLI

```bash
npm install -g vercel
vercel          # follow the prompts
```

The included `vercel.json` pre-configures the build:

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "framework": "vite"
}
```

---

## 📁 Project Structure

```
acoust/
├── index.html              # Vite HTML entry point (SEO meta tags)
├── package.json            # Project metadata and scripts
├── vite.config.js          # Vite + React plugin config
├── vercel.json             # Vercel deployment config
├── .gitignore
├── acoustic-modem.html     # Original standalone prototype (reference)
└── src/
    ├── main.jsx            # React DOM entry point
    ├── index.css           # All global styles (cyberpunk theme)
    └── App.jsx             # Main application component
                            #   ├─ Config state & baud rate calc
                            #   ├─ TX: transmit() + playTone()
                            #   ├─ RX: startListening() / stopListening()
                            #   ├─ Packet: buildHeader() / parseHeader()
                            #   ├─ Codec: bytesToNibbles() / nibblesToBytes()
                            #   ├─ Image: handleImageFile() / compressAndPreview()
                            #   └─ Visualizer: drawVisualizer() (canvas FFT)
```

---

## 🧪 Usage Guide

### Sending a Text Message

1. On the **TX — TRANSMITTER** panel, make sure the **TEXT** tab is active
2. Type your message in the input field
3. Click **▶ TRANSMIT** — your speakers will play the encoded tones
4. On a second device (or the same device with headphones + mic), click **⬤ START LISTENING**
5. The receiver will detect the preamble, decode the nibbles, and display your message in the **Decoded Output** box

> 💡 **Tip:** You can also test on the same browser window — the microphone will pick up your speaker output if your audio hardware allows loopback.

### Sending an Image

1. Switch to the **IMAGE** tab on the TX panel
2. Drag & drop an image file or click to browse
3. Adjust the **IMG SIZE** (smaller = faster) and **JPEG QUALITY** slider
4. The preview shows the compressed image with estimated transmission time
5. Click **▶ TRANSMIT** to send
6. The receiver will show a live progress bar as the image assembles, then render it

### Tips for Best Results

- **Same room**: Place speaker and microphone within 1–2 metres of each other
- **Quiet environment**: Background noise degrades decoding accuracy
- **Slow down**: Increase symbol duration to 120–200ms in noisy environments
- **Wider spacing**: Increase freq spacing to 300Hz+ in reverberant rooms
- **Lower quality**: JPEG quality 15–25% gives tiny payloads for faster transmission

---

## 🛠️ Technical Stack

| Layer | Technology |
|---|---|
| **Framework** | React 18 + Vite 6 |
| **Audio engine** | Web Audio API (`AudioContext`, `OscillatorNode`, `AnalyserNode`) |
| **FFT resolution** | 16384-point FFT for high-frequency precision |
| **Styling** | Vanilla CSS with CSS custom properties (no frameworks) |
| **Fonts** | [Orbitron](https://fonts.google.com/specimen/Orbitron) + [Share Tech Mono](https://fonts.google.com/specimen/Share+Tech+Mono) via Google Fonts |
| **Image codec** | Browser-native JPEG via `canvas.toDataURL()` + `Blob` URL |
| **Deployment** | Vercel (static site / edge network) |

---

## 🔬 Frequency Layout (Default Settings)

```
P     0     1     2     3     4     5     6     7     8     9     A     B     C     D     E     F
│     │     │     │     │     │     │     │     │     │     │     │     │     │     │     │     │
500  1000  1200  1400  1600  1800  2000  2200  2400  2600  2800  3000  3200  3400  3600  3800  4000 Hz
│
Preamble
```

The **yellow P marker** is the preamble detection tone. The **cyan 0–F markers** are the 16 MFSK data frequencies. You can see these in real time on the spectrum visualizer when listening.

---

## 🔒 Privacy & Security

- **100% client-side** — no data ever leaves your browser
- **No server, no WebSocket, no API calls**
- Microphone access is requested only when you click START LISTENING
- All audio processing happens locally in the Web Audio API

---

## 🤝 Contributing

Pull requests are welcome! Some ideas for contributions:

- [ ] Reed-Solomon or Hamming error correction coding
- [ ] CRC checksum in the packet header
- [ ] Variable modulation order (MFSK-4, MFSK-8, MFSK-32)
- [ ] Adaptive baud rate based on channel quality estimation
- [ ] File transfer support (arbitrary binary blobs)
- [ ] QR-code-style 2D acoustic framing
- [ ] Mobile PWA with service worker offline support

---

## 📄 License

MIT © 2026 Alden Noronha

---

<div align="center">
  <strong>ACOUST · MFSK-16 · ACOUSTIC DATA MODEM</strong><br/>
  <em>Because sometimes the air is the best network cable.</em>
</div>
