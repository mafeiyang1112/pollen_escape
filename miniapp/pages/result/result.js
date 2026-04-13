const api = require('../../utils/api')

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

function getLineColor(level) {
  if (level === LEVEL.HIGH) return '#FF5A5F'
  if (level === LEVEL.MID) return '#FF9F43'
  if (level === LEVEL.LOW) return '#3CCF91'
  return '#94A3B8'
}

function toStatusClass(level) {
  if (level === LEVEL.HIGH) return 'status-high'
  if (level === LEVEL.MID) return 'status-mid'
  if (level === LEVEL.LOW) return 'status-low'
  return 'status-unknown'
}

function toRgba(hex, alpha) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function buildResultView(match) {
  if (!match) {
    return {
      finalScore: 0,
      rankText: '--',
      bestDropText: '--',
      comboText: 'x0',
      gradeText: '--',
      gradeDesc: '等待结果数据',
    }
  }

  const finalScore = Number(match.final_score || match.current_score || 0)
  const bestDrop = Number(match.max_effective_drop)
  const combo = Number((match.combo3_count || 0) + (match.combo5_count || 0))

  let gradeText = 'C'
  let gradeDesc = '完成挑战，再冲一次更高分'
  if (finalScore >= 300) {
    gradeText = 'S'
    gradeDesc = '顶级表现，冲榜实力'
  } else if (finalScore >= 200) {
    gradeText = 'A'
    gradeDesc = '节奏稳定，表现优秀'
  } else if (finalScore >= 120) {
    gradeText = 'B'
    gradeDesc = '状态不错，继续提速'
  }

  return {
    finalScore,
    rankText: (match.monthly && match.monthly.rank) || '--',
    bestDropText: Number.isFinite(bestDrop) ? `-${bestDrop.toFixed(1)}` : '--',
    comboText: `x${combo}`,
    gradeText,
    gradeDesc,
  }
}

function formatError(e) {
  if (!e) return '加载结果失败，请稍后重试。'
  return e.message || '加载结果失败，请稍后重试。'
}

Page({
  data: {
    matchId: '',
    match: null,
    samples: [],
    leaderboard: [],
    loading: false,
    lastError: '',
    resultView: buildResultView(null),
    statusClass: 'status-unknown',
    chartWidth: 640,
    chartHeight: 220,
    chartStyle: 'width: 320px; height: 110px;',
    generatingPoster: false,
  },

  onLoad(options) {
    const matchId = options.match_id || ''
    const width = Math.max(260, wx.getWindowInfo().windowWidth - 96)
    const height = 150
    this.setData({
      matchId,
      chartWidth: width,
      chartHeight: height,
      chartStyle: `width: ${width}px; height: ${height}px;`,
    })
  },

  onShow() {
    this.loadResult()
  },

  onShareAppMessage() {
    const score = this.data.resultView.finalScore || 0
    return {
      title: `我在花粉逃离大赛拿了 ${score} 分`,
      path: '/pages/index/index',
    }
  },

  async loadResult() {
    if (!this.data.matchId) return
    this.setData({ loading: true, lastError: '' })
    try {
      const [realtime, leaderboardRes, sampleRes] = await Promise.all([
        api.getMatchRealtime(this.data.matchId),
        api.getMonthlyLeaderboard(10),
        api.getMatchSamples(this.data.matchId, 60),
      ])

      const match = realtime.match || null
      const samples = sampleRes.samples || []
      const level = getLevel(
        samples.length
          ? Number(samples[samples.length - 1].smoothed_value || samples[samples.length - 1].raw_value)
          : Number(match && (match.end_pollen || match.start_pollen))
      )

      this.setData({
        match,
        samples,
        leaderboard: leaderboardRes.leaderboard || [],
        resultView: buildResultView(match),
        statusClass: toStatusClass(level),
      })
      this.drawTrend(samples, level)
    } catch (e) {
      this.setData({ lastError: formatError(e) })
    } finally {
      this.setData({ loading: false })
    }
  },

  drawTrend(samples, level) {
    const width = this.data.chartWidth
    const height = this.data.chartHeight
    const ctx = wx.createCanvasContext('resultTrendCanvas', this)

    ctx.clearRect(0, 0, width, height)

    if (!samples || samples.length < 2) {
      ctx.setFillStyle('#9ca3af')
      ctx.setFontSize(14)
      ctx.fillText('暂无趋势数据', 16, height / 2)
      ctx.draw()
      return
    }

    const values = samples.map((x) => Number(x.smoothed_value || x.raw_value)).filter(Number.isFinite)
    if (values.length < 2) {
      ctx.setFillStyle('#9ca3af')
      ctx.setFontSize(14)
      ctx.fillText('暂无趋势数据', 16, height / 2)
      ctx.draw()
      return
    }

    const color = getLineColor(level)
    const pad = 18
    const minV = Math.min(...values)
    const maxV = Math.max(...values)
    const range = Math.max(1, maxV - minV)
    const innerW = width - pad * 2
    const innerH = height - pad * 2

    const points = values.map((v, idx) => ({
      x: pad + (innerW * idx) / (values.length - 1),
      y: pad + ((maxV - v) / range) * innerH,
    }))

    ctx.setStrokeStyle('#edf1f5')
    ctx.setLineWidth(1)
    for (let i = 0; i < 3; i += 1) {
      const y = pad + (innerH / 2) * i
      ctx.beginPath()
      ctx.moveTo(pad, y)
      ctx.lineTo(width - pad, y)
      ctx.stroke()
    }

    const gradient = ctx.createLinearGradient(0, pad, 0, height - pad)
    gradient.addColorStop(0, toRgba(color, 0.32))
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
    ctx.setStrokeStyle(color)
    ctx.setLineWidth(3)
    ctx.stroke()

    ctx.draw()
  },

  async generatePoster() {
    if (this.data.generatingPoster) return
    this.setData({ generatingPoster: true })

    wx.showLoading({ title: '生成海报中...', mask: true })

    try {
      const rv = this.data.resultView
      const level = this.data.statusClass
      const color = level === 'status-high' ? '#FF6B6B' : level === 'status-mid' ? '#FF9A9E' : '#A8EDEA'

      // 获取 Canvas 2D 实例
      const canvasNode = await new Promise(resolve => {
        wx.createSelectorQuery()
          .select('#posterCanvas')
          .fields({ node: true, size: true })
          .exec((res) => resolve(res[0]))
      })

      const canvas = canvasNode.node
      const ctx = canvas.getContext('2d')
      const w = 620
      const h = 980

      // 获取设备像素比
      const sysInfo = wx.getWindowInfo()
      const dpr = sysInfo.pixelRatio || 2

      // 初始化画布大小并缩放以保证高清
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.scale(dpr, dpr)

      // 开始绘制
      
      // 背景
      const g = ctx.createLinearGradient(0, 0, w, h)
      g.addColorStop(0, color)
      g.addColorStop(1, '#FDA085')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)

      // 标题
      ctx.fillStyle = '#FFFFFF'
      ctx.font = '44px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('花粉逃离大赛', w / 2, 98)
      ctx.font = '28px sans-serif'
      ctx.fillText('我的战绩卡', w / 2, 148)

      // 蜜蜂 emoji
      ctx.font = '70px sans-serif'
      ctx.fillText('🐝', w / 2, 230)

      // 战绩卡主体
      const cardY = 280
      const cardH = 460
      const cardW = 552
      const cardX = (w - cardW) / 2

      ctx.save()
      ctx.shadowColor = 'rgba(0, 0, 0, 0.15)'
      ctx.shadowBlur = 24
      ctx.shadowOffsetY = 12
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
      this.drawRoundRect(ctx, cardX, cardY, cardW, cardH, 32)
      ctx.fill()
      ctx.restore()

      // 得分标签
      ctx.fillStyle = '#6B7280'
      ctx.font = '32px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('本局得分', w / 2, cardY + 90)

      // 得分数字
      const scoreGradient = ctx.createLinearGradient(w / 2 - 100, cardY + 130, w / 2 + 100, cardY + 230)
      scoreGradient.addColorStop(0, '#FFB703')
      scoreGradient.addColorStop(1, '#FFD166')
      ctx.fillStyle = scoreGradient
      ctx.font = 'bold 130px sans-serif'
      ctx.fillText(String(rv.finalScore), w / 2, cardY + 220)

      // 排名
      const rankY = cardY + 300
      const rankH = 70
      const rankW = cardW - 160
      const rankX = cardX + 80
      
      ctx.fillStyle = 'rgba(255, 183, 3, 0.12)'
      this.drawRoundRect(ctx, rankX, rankY, rankW, rankH, 35)
      ctx.fill()
      
      ctx.fillStyle = '#1F2937'
      ctx.font = 'bold 30px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`🏆 排名：#${rv.rankText}`, w / 2, rankY + 48)

      // 装饰元素
      ctx.font = '30px sans-serif'
      ctx.fillText('🌸', cardX + 60, cardY + 120)
      ctx.fillText('🌸', cardX + cardW - 60, cardY + 120)

      // 导出高清图片
      const temp = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas: canvas,
          x: 0,
          y: 0,
          width: w,
          height: h,
          destWidth: w * dpr,
          destHeight: h * dpr,
          fileType: 'png',
          quality: 1,
          success: resolve,
          fail: reject,
        }, this)
      })

      wx.hideLoading()
      wx.previewImage({ urls: [temp.tempFilePath] })

    } catch (e) {
      console.error('generatePoster failed', e)
      wx.hideLoading()
      wx.showToast({ title: '生成失败，请重试', icon: 'none' })
    } finally {
      this.setData({ generatingPoster: false })
    }
  },

  playAgain() {
    wx.reLaunch({ url: '/pages/index/index' })
  },

  backHome() {
    wx.reLaunch({ url: '/pages/index/index' })
  },

  drawRoundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath()
    ctx.moveTo(x + radius, y)
    ctx.lineTo(x + width - radius, y)
    ctx.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0)
    ctx.lineTo(x + width, y + height - radius)
    ctx.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2)
    ctx.lineTo(x + radius, y + height)
    ctx.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI)
    ctx.lineTo(x, y + radius)
    ctx.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 3 / 2)
    ctx.closePath()
  },
})
