// Read the text on the VM console
//
// Linux text consoles draw a known bitmap font on a fixed grid, so their text
// is first read exactly by comparing each character cell with the glyphs of
// common console fonts (console-fonts.js). Other screens (GUI, other fonts)
// fall back to OCR with Tesseract.js.
//
// Everything is self-hosted: Tesseract.js, its WASM core and the English model
// are copied next to the app by `copyAssets` (gulpfile.js) and loaded on first
// use, never from Tesseract.js' default CDN.

import { CHARS, FONTS } from './console-fonts'

const ASSETS = {
  core: 'tesseract.js-core/',
  lang: '@tesseract.js-data/eng/4.0.0_best_int/',
  script: 'tesseract.js/dist/tesseract.min.js',
  worker: 'tesseract.js/dist/worker.min.js',
}

const SCALE = 3 // console fonts are small, upscaling helps recognition a lot
const PADDING = 10 // px of white border around the text, also helps

const CELL_HEIGHT = 16
const CELL_WIDTHS = [8, 9] // framebuffer console / VGA text mode (9th column is a gap)
const INK_DISTANCE = 48 // max RGB channel difference with the cell background
const MAX_GLYPH_DISTANCE = 4 // differing pixels still accepted as the same glyph
const MIN_MATCHED = 0.9 // share of the non-empty cells that must match the font
const UNKNOWN_CHAR = '\ufffd'

const GLYPHS = Object.entries(FONTS).map(([name, hex]) => ({
  name,
  rows: Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16)),
}))

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, i) => {
  let n = 0
  for (let v = i; v !== 0; v >>= 1) {
    n += v & 1
  }
  return n
})

// 16 bytes (one per row, MSB = left pixel) of the ink of a cell, undefined if empty
const getCellBitmap = ({ data, width }, x0, y0) => {
  const colors = new Map()
  let background
  let backgroundCount = 0
  for (let y = 0; y < CELL_HEIGHT; ++y) {
    for (let x = 0; x < 8; ++x) {
      const i = 4 * ((y0 + y) * width + x0 + x)
      const color = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
      const count = (colors.get(color) ?? 0) + 1
      colors.set(color, count)
      if (count > backgroundCount) {
        background = color
        backgroundCount = count
      }
    }
  }
  if (colors.size === 1) {
    return
  }

  const r = background >> 16
  const g = (background >> 8) & 0xff
  const b = background & 0xff
  const bitmap = new Uint8Array(CELL_HEIGHT)
  for (let y = 0; y < CELL_HEIGHT; ++y) {
    let row = 0
    for (let x = 0; x < 8; ++x) {
      const i = 4 * ((y0 + y) * width + x0 + x)
      if (Math.max(Math.abs(data[i] - r), Math.abs(data[i + 1] - g), Math.abs(data[i + 2] - b)) > INK_DISTANCE) {
        row |= 0x80 >> x
      }
    }
    bitmap[y] = row
  }
  return bitmap.some(row => row !== 0) ? bitmap : undefined
}

const matchGlyph = (bitmap, { rows }) => {
  let best = 0
  let bestDistance = Infinity
  for (let glyph = 0; glyph < CHARS.length; ++glyph) {
    let distance = 0
    for (let y = 0; y < CELL_HEIGHT && distance < bestDistance; ++y) {
      distance += POPCOUNT[bitmap[y] ^ rows[glyph * CELL_HEIGHT + y]]
    }
    if (distance < bestDistance) {
      best = glyph
      bestDistance = distance
    }
  }
  return { char: CHARS[best], distance: bestDistance }
}

// a text cursor (underline) on an empty cell
const isCursor = bitmap => bitmap.every((row, y) => y >= 13 || row === 0)

// exact reading of a Linux text console, undefined if the screen doesn't use
// one of the known fonts
const readConsoleFont = (canvas, area) => {
  const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
  let best
  for (const cellWidth of CELL_WIDTHS) {
    // cells whose center is in the area
    const cells = []
    const firstColumn = Math.max(0, Math.ceil(area.x / cellWidth - 0.5))
    const firstRow = Math.max(0, Math.ceil(area.y / CELL_HEIGHT - 0.5))
    const lastColumn = Math.min(
      Math.floor(canvas.width / cellWidth),
      Math.ceil((area.x + area.width) / cellWidth - 0.5)
    )
    const lastRow = Math.min(
      Math.floor(canvas.height / CELL_HEIGHT),
      Math.ceil((area.y + area.height) / CELL_HEIGHT - 0.5)
    )
    for (let row = firstRow; row < lastRow; ++row) {
      const line = []
      for (let column = firstColumn; column < lastColumn; ++column) {
        line.push(getCellBitmap(image, column * cellWidth, row * CELL_HEIGHT))
      }
      cells.push(line)
    }
    const inked = cells.flat().filter(bitmap => bitmap !== undefined)
    if (inked.length === 0) {
      continue
    }

    for (const font of GLYPHS) {
      let matched = 0
      let unknown = 0
      const lines = cells.map(line =>
        line
          .map(bitmap => {
            if (bitmap === undefined) {
              return ' '
            }
            const { char, distance } = matchGlyph(bitmap, font)
            if (distance <= MAX_GLYPH_DISTANCE) {
              ++matched
              return char
            }
            if (isCursor(bitmap)) {
              ++matched
              return ' '
            }
            ++unknown
            return UNKNOWN_CHAR
          })
          .join('')
          .replace(/\s+$/, '')
      )
      if (best === undefined || matched / inked.length > best.ratio) {
        best = { font: font.name, lines, ratio: matched / inked.length, unknown }
      }
    }
  }
  if (best !== undefined && best.ratio >= MIN_MATCHED) {
    const { font, lines, unknown } = best
    return {
      font,
      method: 'font',
      text: lines.join('\n').replace(/^\n+|\s+$/g, ''),
      unknown,
    }
  }
}

const assetUrl = path => new URL(path, document.baseURI).href

const loadScript = url =>
  new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.onload = resolve
    script.onerror = () => reject(new Error('cannot load ' + url))
    script.src = url
    document.head.appendChild(script)
  })

let workerPromise
const getWorker = () => {
  if (workerPromise === undefined) {
    workerPromise = (async () => {
      const options = {
        corePath: assetUrl(ASSETS.core),
        langPath: assetUrl(ASSETS.lang),
        workerPath: assetUrl(ASSETS.worker),
      }
      Object.values(options).forEach(url => {
        if (new URL(url).origin !== window.location.origin) {
          throw new Error('OCR assets must be served by XO: ' + url)
        }
      })

      if (window.Tesseract === undefined) {
        await loadScript(assetUrl(ASSETS.script))
      }
      const { createWorker, OEM, PSM } = window.Tesseract
      const worker = await createWorker('eng', OEM.LSTM_ONLY, options)
      await worker.setParameters({
        preserve_interword_spaces: '1',
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      })
      return worker
    })()
    workerPromise.catch(() => {
      workerPromise = undefined
    })
  }
  return workerPromise
}

// Otsu's method: threshold that best separates the 2 classes of a histogram
const otsuThreshold = (histogram, total) => {
  let sum = 0
  for (let i = 0; i < 256; ++i) {
    sum += i * histogram[i]
  }
  let sumBackground = 0
  let weightBackground = 0
  let best = 0
  let threshold = 127
  for (let i = 0; i < 256; ++i) {
    weightBackground += histogram[i]
    if (weightBackground === 0) {
      continue
    }
    const weightForeground = total - weightBackground
    if (weightForeground === 0) {
      break
    }
    sumBackground += i * histogram[i]
    const meanBackground = sumBackground / weightBackground
    const meanForeground = (sum - sumBackground) / weightForeground
    const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2
    if (between > best) {
      best = between
      threshold = i
    }
  }
  return threshold
}

// upscaled, black text on white: what Tesseract reads best
const prepareImage = (source, { x, y, width, height }) => {
  const scaled = document.createElement('canvas')
  scaled.width = width * SCALE
  scaled.height = height * SCALE
  const scaledContext = scaled.getContext('2d')
  scaledContext.imageSmoothingQuality = 'high'
  scaledContext.drawImage(source, x, y, width, height, 0, 0, scaled.width, scaled.height)

  const image = scaledContext.getImageData(0, 0, scaled.width, scaled.height)
  const { data } = image
  const n = data.length / 4
  const gray = new Uint8Array(n)
  const histogram = new Array(256).fill(0)
  for (let i = 0; i < n; ++i) {
    const value = Math.round(0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2])
    gray[i] = value
    ++histogram[value]
  }
  const threshold = otsuThreshold(histogram, n)
  let light = 0
  for (let i = threshold + 1; i < 256; ++i) {
    light += histogram[i]
  }
  // text is the minority of the pixels: light text on a dark console is the usual case
  const lightText = light < n / 2
  for (let i = 0; i < n; ++i) {
    const isText = lightText ? gray[i] > threshold : gray[i] <= threshold
    const value = isText ? 0 : 255
    data[4 * i] = data[4 * i + 1] = data[4 * i + 2] = value
    data[4 * i + 3] = 255
  }
  scaledContext.putImageData(image, 0, 0)

  const padded = document.createElement('canvas')
  padded.width = scaled.width + 2 * PADDING
  padded.height = scaled.height + 2 * PADDING
  const paddedContext = padded.getContext('2d')
  paddedContext.fillStyle = '#fff'
  paddedContext.fillRect(0, 0, padded.width, padded.height)
  paddedContext.drawImage(scaled, PADDING, PADDING)
  return padded
}

// `area` is in canvas pixels, the whole canvas when undefined
//
// resolves with `{ method: 'font', font, text, unknown }` (exact reading,
// `unknown` characters shown as U+FFFD) or `{ method: 'ocr', confidence, text }`
export const readCanvasText = async (canvas, area = { x: 0, y: 0, width: canvas.width, height: canvas.height }) => {
  const exact = readConsoleFont(canvas, area)
  if (exact !== undefined) {
    return exact
  }

  const worker = await getWorker()
  const { data } = await worker.recognize(prepareImage(canvas, area))
  return {
    confidence: Math.round(data.confidence),
    method: 'ocr',
    text: data.text.replace(/\s+$/, ''),
  }
}
