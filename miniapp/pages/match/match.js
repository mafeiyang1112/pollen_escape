const api = require('../../utils/api')
const app = getApp()

const LEVEL = {
  HIGH: 'high',
  MID: 'mid',
  LOW: 'low',
  UNKNOWN: 'unknown',
}

function getLevel(pollenValue) {
  const v = Number(pollenValue)
  if (!Number.isFinite(v)) return LEVEL.UNKNOWN
  if (v > 85) return LEVEL.HIGH
  if (v >= 60) return LEVEL.MID
  return LEVEL.LOW
}

function toStatusClass(level) {
  if (level === LEVEL.HIGH) return 'status-high'
  if (level === LEVEL.MID) return 'status-mid'
  if (level === LEVEL.LOW) return 'status-low'
  return 'status-unknown'
}

function getLineColor(level) {
  if (level === LEVEL.HIGH) return '#FF5A5F'
  if (level === LEVEL.MID) return '#FF9F43'
  if (level === LEVEL.LOW) return '#3CCF91'
  return '#94A3B8'
}

function toRgba(hex, alpha) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function formatError(e) {
  if (!e) return '加载失败，请稍后重试。'
  return e.message || '加载失败，请稍后重试。'
}

function getStatusHint({ status, waitingForData, trendDirection, level }) {
  if (status !== 'active') return '本局已结束，结算已完成。'
  if (waitingForData) return '逃离中…等待设备新数据'
  if (level === LEVEL.LOW) return '进入安全区！'
  if (trendDirection === 'down') return '下降加速！'
  if (trendDirection === 'up') return '浓度回升，建议继续移动'
  return '逃离中…保持移动节奏'
}

Page({
  data: {
    matchId: '',
    match: null,
    samples: [],
    waitingForData: false,
    polling: false,
    lastError: '',
    currentPollenText: '--',
    trendArrow: '-',
    statusHint: '逃离中…',
    statusClass: 'status-unknown',
    statusText: '未知',
    scoreText: '0',
    scoreDeltaText: '',
    showScoreDelta: false,
    comboText: '连击 x0',
    comboFlash: false,
    lastScore: 0,
    lastCombo: 0,
    finishShown: false,
    chartWidth: 640,
    chartHeight: 220,
    chartStyle: 'width: 320px; height: 110px;',
  },

  onLoad(options) {
    const matchId = options.match_id || ''
    if (!matchId) {
      wx.showToast({ title: '缺少比赛信息', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 500)
      return
    }

    const width = Math.max(260, wx.getWindowInfo().windowWidth - 96)
    const height = 154

    this.setData({
      matchId,
      chartWidth: width,
      chartHeight: height,
      chartStyle: `width: ${width}px; height: ${height}px;`,
    })
  },

  onShow() {
    this.startPolling()
  },

  onHide() {
    this.stopPolling()
    this.clearFxTimer()
  },

  onUnload() {
    this.stopPolling()
    this.clearFxTimer()
  },

  startPolling() {
    if (this._timer || !this.data.matchId) return
    this.fetchRealtime()
    this._timer = setInterval(() => this.fetchRealtime(), 3000)
  },

  stopPolling() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  },

  clearFxTimer() {
    if (this._fxTimer) {
      clearTimeout(this._fxTimer)
      this._fxTimer = null
    }
  },

  async fetchRealtime() {
    if (this.data.polling || !this.data.matchId) return
    this.setData({ polling: true, lastError: '' })

    try {
      const [realtime, sampleRes] = await Promise.all([
        api.getMatchRealtime(this.data.matchId),
        api.getMatchSamples(this.data.matchId, 60),
      ])

      const match = realtime.match || null
      const samples = sampleRes.samples || []
      const lastSample = samples.length ? samples[samples.length - 1] : null

      const currentPollen =
        (lastSample && Number(lastSample.smoothed_value || lastSample.raw_value)) ||
        (match && Number(match.end_pollen || match.start_pollen))

      const level = getLevel(currentPollen)
      const statusClass = toStatusClass(level)
      const currentPollenText = Number.isFinite(currentPollen)
        ? currentPollen.toFixed(0)
        : '--'

      // 检查是否需要播放警报
      this.checkAndPlayAlert(level)

      let trendArrow = '-'
      if (samples.length >= 2) {
        const prev = Number(samples[samples.length - 2].smoothed_value)
        const curr = Number(samples[samples.length - 1].smoothed_value)
        if (Number.isFinite(prev) && Number.isFinite(curr)) {
          trendArrow = curr < prev ? '↓' : curr > prev ? '↑' : '→'
        }
      }

      const trendDirection = trendArrow === '↓' ? 'down' : trendArrow === '↑' ? 'up' : 'flat'
      const statusHint = getStatusHint({
        status: (match && match.status) || 'active',
        waitingForData: !!realtime.waiting_for_data,
        trendDirection,
        level,
      })
      const statusText =
        level === LEVEL.HIGH
          ? '高浓度'
          : level === LEVEL.MID
            ? '中浓度'
            : level === LEVEL.LOW
              ? '低浓度'
              : '未知'

      const nextScore = Number((match && (match.current_score || match.final_score)) || 0)
      const prevScore = Number(this.data.lastScore || 0)
      const nextCombo = Number(((match && match.combo3_count) || 0) + ((match && match.combo5_count) || 0))

      const payload = {
        match,
        samples,
        waitingForData: !!realtime.waiting_for_data,
        currentPollenText,
        trendArrow,
        statusHint,
        statusClass,
        statusText,
        scoreText: String(nextScore),
        comboText: `连击 x${nextCombo}`,
        lastScore: nextScore,
        lastCombo: nextCombo,
      }

      const hasPrevMatch = !!this.data.match
      if (hasPrevMatch && nextScore > prevScore) {
        payload.scoreDeltaText = `+${nextScore - prevScore}`
        payload.showScoreDelta = true
      }

      if (hasPrevMatch && nextCombo > this.data.lastCombo) {
        payload.comboFlash = true
      }

      this.setData(payload)
      this.drawTrend(samples, level)

      if (payload.showScoreDelta || payload.comboFlash) {
        this.clearFxTimer()
        this._fxTimer = setTimeout(() => {
          this.setData({ showScoreDelta: false, comboFlash: false })
        }, 680)
      }

      if (match && match.status !== 'active') {
        this.stopPolling()
        if (!this.data.finishShown) {
          this.setData({ finishShown: true })
          wx.showModal({
            title: match.status === 'ended' ? '成功逃离！' : '比赛结束',
            content: `本次得分：${nextScore}`,
            confirmText: '查看结果',
            cancelText: '返回首页',
            success: (res) => {
              if (res.confirm) {
                this.goResult()
              } else {
                this.backHome()
              }
            },
          })
        }
      }
    } catch (e) {
      this.setData({ lastError: formatError(e) })
    } finally {
      this.setData({ polling: false })
    }
  },

  drawTrend(samples, level) {
    const width = this.data.chartWidth
    const height = this.data.chartHeight
    const ctx = wx.createCanvasContext('trendCanvas', this)

    ctx.clearRect(0, 0, width, height)

    if (!samples || samples.length < 2) {
      ctx.setFillStyle('#9ca3af')
      ctx.setFontSize(14)
      ctx.fillText('等待趋势数据...', 16, height / 2)
      ctx.draw()
      return
    }

    const values = samples.map((x) => Number(x.smoothed_value || x.raw_value)).filter(Number.isFinite)
    if (values.length < 2) {
      ctx.setFillStyle('#9ca3af')
      ctx.setFontSize(14)
      ctx.fillText('等待趋势数据...', 16, height / 2)
      ctx.draw()
      return
    }

    const color = getLineColor(level)
    const pad = 20
    const minV = Math.min(...values)
    const maxV = Math.max(...values)
    const range = Math.max(1, maxV - minV)
    const innerW = width - pad * 2
    const innerH = height - pad * 2

    ctx.setStrokeStyle('#edf1f5')
    ctx.setLineWidth(1)
    for (let i = 0; i < 3; i += 1) {
      const y = pad + (innerH / 2) * i
      ctx.beginPath()
      ctx.moveTo(pad, y)
      ctx.lineTo(width - pad, y)
      ctx.stroke()
    }

    const points = values.map((v, idx) => {
      const x = pad + (innerW * idx) / (values.length - 1)
      const y = pad + ((maxV - v) / range) * innerH
      return { x, y }
    })

    const gradient = ctx.createLinearGradient(0, pad, 0, height - pad)
    gradient.addColorStop(0, toRgba(color, 0.34))
    gradient.addColorStop(1, toRgba(color, 0.03))

    ctx.beginPath()
    ctx.moveTo(points[0].x, height - pad)
    points.forEach((p) => ctx.lineTo(p.x, p.y))
    ctx.lineTo(points[points.length - 1].x, height - pad)
    ctx.closePath()
    ctx.setFillStyle(gradient)
    ctx.fill()

    ctx.beginPath()
    points.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    })
    ctx.setLineWidth(3)
    ctx.setStrokeStyle(color)
    ctx.stroke()

    const last = points[points.length - 1]
    ctx.beginPath()
    ctx.arc(last.x, last.y, 4, 0, Math.PI * 2)
    ctx.setFillStyle(color)
    ctx.fill()

    ctx.draw()
  },

  goResult() {
    wx.navigateTo({
      url: `/pages/result/result?match_id=${encodeURIComponent(this.data.matchId)}`,
    })
  },

  backHome() {
    wx.reLaunch({ url: '/pages/index/index' })
  },

  // 播放警报声音
  playAlertSound() {
    const soundEnabled = app.getSoundEnabled()
    if (!soundEnabled) return

    try {
      // 使用系统默认的提示音
      wx.playBeep({ type: 'system', success: () => {} })
    } catch (e) {
      // 兼容处理：如果 playBeep 不可用，使用 vibrate
      try {
        wx.vibrateShort({ success: () => {} })
      } catch (err) {
        console.log('No sound or vibration available')
      }
    }
  },

  // 检查是否需要播放警报
  checkAndPlayAlert(level) {
    if (level === LEVEL.HIGH) {
      this.playAlertSound()
    }
  },
})
