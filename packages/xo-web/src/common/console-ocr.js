// OCR of the VM console with Tesseract.js
//
// Everything is self-hosted: the engine, its WASM core and the English model
// are copied next to the app by `copyAssets` (gulpfile.js) and loaded on first
// use, never from Tesseract.js' default CDN.

const ASSETS = {
  core: 'tesseract.js-core/',
  lang: '@tesseract.js-data/eng/4.0.0_best_int/',
  script: 'tesseract.js/dist/tesseract.min.js',
  worker: 'tesseract.js/dist/worker.min.js',
}

const SCALE = 3 // console fonts are small, upscaling helps recognition a lot
const PADDING = 10 // px of white border around the text, also helps

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
export const readCanvasText = async (canvas, area = { x: 0, y: 0, width: canvas.width, height: canvas.height }) => {
  const worker = await getWorker()
  const { data } = await worker.recognize(prepareImage(canvas, area))
  return {
    confidence: Math.round(data.confidence),
    text: data.text.replace(/\s+$/, ''),
  }
}
