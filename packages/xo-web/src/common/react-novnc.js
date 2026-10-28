import PropTypes from 'prop-types'
import React, { Component } from 'react'
import RFB from '@nraynaud/novnc/lib/rfb'
import XtScancode from '@nraynaud/novnc/lib/input/xtscancodes'
import URL from 'url-parse'
import { createBackoff } from 'jsonrpc-websocket-client'
import { enable as enableShortcuts, disable as disableShortcuts } from 'shortcuts'

import { readCanvasText } from './console-ocr'

const PROTOCOL_ALIASES = {
  'http:': 'ws:',
  'https:': 'wss:',
}
const fixProtocol = url => {
  const protocol = PROTOCOL_ALIASES[url.protocol]
  if (protocol) {
    url.protocol = protocol
  }
}

// US QWERTY layout: char -> [code, shift]
const US_KEYS = { ' ': ['Space', false], '\n': ['Enter', false], '\t': ['Tab', false] }
;[
  ['`~', 'Backquote'],
  ['-_', 'Minus'],
  ['=+', 'Equal'],
  ['[{', 'BracketLeft'],
  [']}', 'BracketRight'],
  ['\\|', 'Backslash'],
  [';:', 'Semicolon'],
  ['\'"', 'Quote'],
  [',<', 'Comma'],
  ['.>', 'Period'],
  ['/?', 'Slash'],
  ...'1!2@3#4$5%6^7&8*9(0)'.match(/../g).map(pair => [pair, 'Digit' + pair[0]]),
  ...'abcdefghijklmnopqrstuvwxyz'.split('').map(c => [c + c.toUpperCase(), 'Key' + c.toUpperCase()]),
].forEach(([chars, code]) => {
  US_KEYS[chars[0]] = [code, false]
  US_KEYS[chars[1]] = [code, true]
})

const SPECIAL_KEYSYMS = { Enter: 0xff0d, ShiftLeft: 0xffe1, Tab: 0xff09 }

const KEY_DELAY = 15 // ms between key events

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const MIN_SELECTION = 5 // px, smaller drags are clicks

export const getUntypableChars = text =>
  [...new Set(text.replace(/\r\n?/g, '\n'))].filter(c => US_KEYS[c] === undefined)

export default class NoVnc extends Component {
  static propTypes = {
    onClipboardChange: PropTypes.func,
    url: PropTypes.string.isRequired,
  }

  constructor(props) {
    super(props)
    this._rfb = null
    this.state = { selecting: false, selection: undefined }
    this._retryGen = createBackoff(Infinity)

    this._onUpdateState = (rfb, state) => {
      if (state === 'normal') {
        if (this._retryTimeout) {
          clearTimeout(this._retryTimeout)
          this._retryTimeout = undefined
          this._retryGen = createBackoff(Infinity)
        }
      }

      if (state !== 'disconnected' || this.refs.canvas == null) {
        return
      }

      clearTimeout(this._retryTimeout)
      this._retryTimeout = setTimeout(this._connect, this._retryGen.next().value)
    }
  }

  sendCtrlAltDel() {
    const rfb = this._rfb
    if (rfb) {
      rfb.sendCtrlAltDel()
    }
  }

  setClipboard(text) {
    const rfb = this._rfb
    if (rfb) {
      rfb.clipboardPasteFrom(text)
    }
  }

  _sendKey(keysym, code, down) {
    const rfb = this._rfb
    if (rfb._qemuExtKeyEventSupported) {
      RFB.messages.QEMUExtendedKeyEvent(rfb._sock, keysym, down, XtScancode[code])
    } else {
      rfb.sendKey(keysym, down)
    }
  }

  // simulate typing `text` on the remote keyboard, as if typed manually
  async typeText(text) {
    text = text.replace(/\r\n?/g, '\n')
    const untypable = getUntypableChars(text)
    if (untypable.length !== 0) {
      throw new Error('cannot type these characters: ' + untypable.join(' '))
    }

    const shift = SPECIAL_KEYSYMS.ShiftLeft
    for (const char of text) {
      if (this._rfb === null) {
        throw new Error('console disconnected')
      }
      const [code, needsShift] = US_KEYS[char]
      const keysym = SPECIAL_KEYSYMS[code] || char.charCodeAt(0)
      if (needsShift) {
        this._sendKey(shift, 'ShiftLeft', true)
        await wait(KEY_DELAY)
      }
      this._sendKey(keysym, code, true)
      await wait(KEY_DELAY)
      this._sendKey(keysym, code, false)
      await wait(KEY_DELAY)
      if (needsShift) {
        this._sendKey(shift, 'ShiftLeft', false)
        await wait(KEY_DELAY)
      }
    }
  }

  // Let the user drag a rectangle on the console.
  //
  // Resolves with the area in canvas pixels, `undefined` for a simple click
  // (whole screen) or `null` if cancelled.
  selectArea() {
    this.cancelSelectArea()
    this._unfocus()
    return new Promise(resolve => {
      this._resolveSelection = resolve
      this.setState({ selecting: true, selection: undefined })
    })
  }

  cancelSelectArea = () => {
    this._endSelection(null)
  }

  // OCR of the console, `area` as returned by `selectArea()`
  readText(area) {
    return readCanvasText(this.refs.canvas, area)
  }

  _endSelection(area) {
    window.removeEventListener('mousemove', this._onSelectionMove)
    window.removeEventListener('mouseup', this._onSelectionEnd)
    const resolve = this._resolveSelection
    if (resolve !== undefined) {
      this._resolveSelection = undefined
      this.setState({ selecting: false, selection: undefined })
      resolve(area)
    }
  }

  _getOverlayPoint(event) {
    const { canvas } = this.refs
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
    }
  }

  _onSelectionStart = event => {
    event.preventDefault()
    const start = this._getOverlayPoint(event)
    this.setState({ selection: { start, end: start } })
    window.addEventListener('mousemove', this._onSelectionMove)
    window.addEventListener('mouseup', this._onSelectionEnd)
  }

  _onSelectionMove = event => {
    const { selection } = this.state
    if (selection !== undefined) {
      this.setState({ selection: { ...selection, end: this._getOverlayPoint(event) } })
    }
  }

  _onSelectionEnd = event => {
    const { selection } = this.state
    if (selection === undefined) {
      return
    }
    const { start } = selection
    const end = this._getOverlayPoint(event)
    if (Math.abs(end.x - start.x) < MIN_SELECTION || Math.abs(end.y - start.y) < MIN_SELECTION) {
      this._endSelection(undefined)
      return
    }

    // the canvas may be displayed scaled
    const { canvas } = this.refs
    const ratio = canvas.width / canvas.getBoundingClientRect().width
    const x = Math.floor(Math.min(start.x, end.x) * ratio)
    const y = Math.floor(Math.min(start.y, end.y) * ratio)
    this._endSelection({
      x,
      y,
      width: Math.min(Math.ceil(Math.abs(end.x - start.x) * ratio), canvas.width - x),
      height: Math.min(Math.ceil(Math.abs(end.y - start.y) * ratio), canvas.height - y),
    })
  }

  _clean() {
    const rfb = this._rfb
    if (rfb) {
      this._rfb = null
      rfb.disconnect()
    }
    enableShortcuts()
  }

  _connect = () => {
    this._clean()

    const { canvas } = this.refs
    if (!canvas) {
      return
    }

    const url = new URL(this.props.url)
    fixProtocol(url)

    const isSecure = url.protocol === 'wss:'

    const { onClipboardChange } = this.props
    const rfb = (this._rfb = new RFB({
      encrypt: isSecure,
      target: this.refs.canvas,
      onClipboard:
        onClipboardChange &&
        ((_, text) => {
          onClipboardChange(text)
        }),
      onUpdateState: this._onUpdateState,
    }))

    // remove leading slashes from the path
    //
    // a leading slash will be added by noVNC
    const clippedPath = url.pathname.replace(/^\/+/, '')

    // a port is required
    //
    // if not available from the URL, use the default ones
    const port = url.port || (isSecure ? 443 : 80)

    rfb.connect(url.hostname, port, null, clippedPath)
    disableShortcuts()
  }

  componentDidMount() {
    this._connect()
  }

  componentWillUnmount() {
    this.cancelSelectArea()
    this._clean()
  }

  componentWillReceiveProps(props) {
    const rfb = this._rfb
    if (rfb && this.props.scale !== props.scale) {
      rfb.get_display().set_scale(props.scale || 1)
      rfb.get_mouse().set_scale(props.scale || 1)
    }
  }

  _focus = () => {
    const rfb = this._rfb
    if (rfb) {
      const { activeElement } = document
      if (activeElement) {
        activeElement.blur()
      }

      rfb.get_keyboard().grab()
      rfb.get_mouse().grab()

      disableShortcuts()
    }
  }

  _unfocus = () => {
    const rfb = this._rfb
    if (rfb) {
      rfb.get_keyboard().ungrab()
      rfb.get_mouse().ungrab()

      enableShortcuts()
    }
  }

  _renderSelectionOverlay() {
    const { canvas } = this.refs
    const { selection } = this.state
    return (
      <div
        onMouseDown={this._onSelectionStart}
        style={{
          cursor: 'crosshair',
          height: canvas.offsetHeight,
          left: canvas.offsetLeft,
          position: 'absolute',
          top: canvas.offsetTop,
          width: canvas.offsetWidth,
        }}
      >
        {selection !== undefined && (
          <div
            style={{
              background: 'rgba(51, 122, 183, 0.25)',
              border: '1px solid #337ab7',
              height: Math.abs(selection.end.y - selection.start.y),
              left: Math.min(selection.start.x, selection.end.x),
              position: 'absolute',
              top: Math.min(selection.start.y, selection.end.y),
              width: Math.abs(selection.end.x - selection.start.x),
            }}
          />
        )}
      </div>
    )
  }

  render() {
    return (
      <div style={{ position: 'relative' }}>
        <canvas
          className='center-block'
          height='480'
          onMouseEnter={this._focus}
          onMouseLeave={this._unfocus}
          ref='canvas'
          width='640'
        />
        {this.state.selecting && this._renderSelectionOverlay()}
      </div>
    )
  }
}
