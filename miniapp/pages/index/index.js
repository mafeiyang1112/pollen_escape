const api = require('../../utils/api')
const app = getApp()

const LEVEL = {
  HIGH: 'high',
  MID: 'mid',
  LOW: 'low',
  UNKNOWN: 'unknown',
}
const MATCH_DATA_FRESH_SEC = 30
const KEY_HOME_COOLDOWN_UNTIL = 'home_cooldown_until_ms'

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function getLevel(pollenValue) {
  const v = Number(pollenValue)
  if (!Number.isFinite(v)) return LEVEL.UNKNOWN
  if (v > 85) return LEVEL.HIGH
  if (v >= 60) return LEVEL.MID
  return LEVEL.LOW
}

function getThemeClass(level) {
  if (level === LEVEL.HIGH) return 'theme-danger'
  if (level === LEVEL.MID) return 'theme-warn'
  if (level === LEVEL.LOW) return 'theme-safe'
  return 'theme-idle'
}

function getStatusText(level) {
  if (level === LEVEL.HIGH) return 'high'
  if (level === LEVEL.MID) return 'mid'
  if (level === LEVEL.LOW) return 'low'
  return 'unknown'
}

function getStatusClass(level) {
  if (level === LEVEL.HIGH) return 'status-high'
  if (level === LEVEL.MID) return 'status-mid'
  if (level === LEVEL.LOW) return 'status-low'
  return 'status-unknown'
}

function formatAgeText(ageSec) {
  if (ageSec < 60) return `${ageSec}s ago`
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`
  return `${Math.floor(ageSec / 3600)}h ago`
}

function getGaugeColor(level) {
  if (level === LEVEL.HIGH) return '#FF6F7D'
  if (level === LEVEL.MID) return '#FF9F45'
  if (level === LEVEL.LOW) return '#2FC68F'
  return '#7C8EA5'
}

function normalizeAvatarUrl(url) {
  const value = String(url || '').trim()
  if (!value) return ''
  if (value.startsWith('wxfile://')) return ''
  if (value.startsWith('http://127.0.0.1:') && value.includes('/__tmp__/')) return ''
  return value
}

function buildLatestView(latest) {
  if (!latest) {
    const level = LEVEL.UNKNOWN
    return {
      level,
      levelText: getStatusText(level),
      levelClass: getStatusClass(level),
      themeClass: getThemeClass(level),
      isOnline: false,
      isFresh: false,
      ageSec: 0,
      onlineText: '未连接',
      ageText: '等待设备上传数据',
      pollenText: '--',
      meterWidth: 0,
      trendHint: '暂无趋势',
    }
  }

  const pollenValue = Number(latest.pollen_value)
  const ageSec = Math.max(0, Number(latest.age_sec) || 0)
  const level = getLevel(pollenValue)
  const isFresh = ageSec < MATCH_DATA_FRESH_SEC

  let trendHint = ''
  if (!isFresh) {
    trendHint = '数据已过期，请先等待设备上传新数据'
  } else {
    const canStart = Number.isFinite(pollenValue) && pollenValue >= 60
    trendHint =
      level === LEVEL.HIGH
        ? '当前浓度偏高，已达到开赛阈值（>=60）'
        : canStart
          ? '浓度中等，已达到开赛阈值（>=60）'
          : level === LEVEL.LOW
            ? '已接近安全区，当前不能开赛（需要>=60）'
            : '等待实时数据'
  }

  return {
    level,
    levelText: getStatusText(level),
    levelClass: getStatusClass(level),
    themeClass: getThemeClass(level),
    isOnline: ageSec <= 15,
    isFresh,
    ageSec,
    onlineText: ageSec <= 15 ? '已连接' : '连接波动',
    ageText: `刚${formatAgeText(ageSec)}更新`,
    pollenText: Number.isFinite(pollenValue) ? pollenValue.toFixed(0) : '--',
    meterWidth: Number.isFinite(pollenValue) ? clamp((pollenValue / 150) * 100, 0, 100) : 0,
    trendHint,
  }
}
function formatError(e, fallback) {
  if (!e) return fallback
  if (e.code === 'NETWORK_ERROR') return '无法连接服务端，请检查网络和后端状态'
  if (e.code === 'NO_DEVICE_DATA') return '设备还没有上传数据，请稍后重试'
  if (e.code === 'STALE_DEVICE_DATA') return '设备数据已过期，请先等待新数据'
  if (e.code === 'START_THRESHOLD_NOT_MET') return '当前浓度低于开赛阈值，需要达到 60（含）以上'
  if (e.code === 'COOLDOWN_NOT_REACHED') {
    const sec = (e.payload && e.payload.error && e.payload.error.retry_after_sec) || 0
    if (sec > 0) return `冷却中，请等待 ${sec} 秒`
    return '冷却中，请稍后再试'
  }
  return e.message || fallback
}
function toMonthly(profile) {
  const m = profile && profile.monthly
  return {
    totalScore: (m && m.total_score) || 0,
    rank: (m && m.rank) || '--',
  }
}

Page({
  data: {
    deviceId: '',
    userOpenid: '',
    nickname: '',
    latest: null,
    latestView: buildLatestView(null),
    leaderboard: [],
    recentMatches: [],
    loading: false,
    starting: false,
    stopping: false,
    lastError: '',
    activeMatchId: '',
    cooldownLeftSec: 0,
    themeClass: getThemeClass(LEVEL.UNKNOWN),
    monthlyScore: 0,
    monthlyRank: '--',
    testModeText: '',
    gaugeWidth: 230,
    gaugeHeight: 136,
    gaugeStyle: 'width: 115px; height: 68px;',
    gaugeWrapStyle: 'width: 115px; height: 68px;',
    soundEnabled: true,
    dailyLimitReached: false,
  },

  goToLogin() {
    wx.navigateTo({
      url: '/pages/login/login',
    })
  },

  onLoad() {
    this._gaugeProgress = 0
    this._gaugeTimer = null
    const app = getApp()
    const deviceId = wx.getStorageSync('device_id') || app.globalData.defaultDeviceId
    const nickname = wx.getStorageSync('nickname') || 'player'
    const avatarUrl = normalizeAvatarUrl(wx.getStorageSync('avatarUrl') || '')
    const userOpenid = app.globalData.userOpenid || wx.getStorageSync('user_openid') || ''

    // 闁告帗绻傞～鎰板礌閺嵮嶇矗闂傚﹤鍟跨槐鎴﹀礂瀹曞洤笑闁?
    const soundEnabled = app.getSoundEnabled()

    this.setData({
      deviceId,
      nickname,
      avatarUrl,
      userOpenid,
      soundEnabled,
      dailyLimitReached: false,
    })
    app.globalData.defaultDeviceId = deviceId
    this.restoreCooldownFromStorage()

    // Perform check for login
    if (!userOpenid) {
      // Not authenticated, redirect to login
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }

    this.refreshHome()
    this.syncTestMode()
    this.prepareGaugeCanvas()
  },

  onShow() {
    this.restoreCooldownFromStorage()
    this.syncTestMode()
    if (this.data.userOpenid) {
      this.refreshHome()
    }
  },

  onHide() {
    this.clearCooldownTimer()
    this.clearGaugeTimer()
  },

  onUnload() {
    this.clearCooldownTimer()
    this.clearGaugeTimer()
  },

  onPullDownRefresh() {
    this.refreshHome().finally(() => wx.stopPullDownRefresh())
  },

  async refreshHome() {
    if (!this.data.userOpenid) return

    this.setData({ loading: true, lastError: '' })

    const promises = [
      api.getLatestDevice(this.data.deviceId),
      api.getMonthlyLeaderboard(5),
      api.getActiveMatch({
        deviceId: this.data.deviceId,
        userOpenid: this.data.userOpenid,
      }),
      this.data.userOpenid
        ? api.getUserProfile(this.data.userOpenid).catch(() => null)
        : Promise.resolve(null),
    ]

    try {
      const [latestR, leaderboardR, activeR, profile] = await Promise.allSettled(promises)

      const latest = latestR.status === 'fulfilled' ? latestR.value.latest || null : null
      const latestView = buildLatestView(latest)

      const board =
        leaderboardR.status === 'fulfilled' ? leaderboardR.value.leaderboard || [] : []

      const activeMatchId =
        activeR.status === 'fulfilled'
          ? (activeR.value.active_match && activeR.value.active_match.match_id) || ''
          : ''

      const profileValue = profile.status === 'fulfilled' ? profile.value : null
      const profileUser = (profileValue && profileValue.user) || null
      const monthly = toMonthly(profileValue)
      const recentMatches = (profileValue && profileValue.recent_matches) || []

      // 闁告艾鏈鐐哄触鎼达綆浼傞柡鍕暩琚ㄩ柛婊冭嫰閵囨棃宕撹箛鎾崇厒闁哄牜鍓欏﹢瀵哥磽閹惧磭鎽?
      const backendNickname = profileUser && profileUser.nickname
      const backendAvatar = normalizeAvatarUrl(profileUser && profileUser.avatar_url)
      if (backendNickname && backendNickname !== this.data.nickname) {
        wx.setStorageSync('nickname', backendNickname)
      }
      if (backendAvatar && backendAvatar !== this.data.avatarUrl) {
        wx.setStorageSync('avatarUrl', backendAvatar)
      }

      const firstError =
        latestR.status === 'rejected'
          ? latestR.reason
          : leaderboardR.status === 'rejected'
            ? leaderboardR.reason
            : activeR.status === 'rejected'
              ? activeR.reason
              : null

      this.setData({
        latest,
        latestView,
        leaderboard: board,
        activeMatchId,
        recentMatches,
        nickname: backendNickname || this.data.nickname || '闁奸缚浜惌鍥箰閹寸偛鐏涢柤?',
        avatarUrl: backendAvatar || this.data.avatarUrl || 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0',
        monthlyScore: monthly.totalScore,
        monthlyRank: monthly.rank,
        themeClass: latestView.themeClass,
        lastError: firstError ? formatError(firstError, '闁告帡鏀遍弻濠冨緞鏉堫偉袝闁挎稑鐭侀顒傜矙瀹ュ懏鍊甸梺鎻掔Х閻?') : '',
      })
      this.animateGaugeTo(latestView)
    } finally {
      this.setData({ loading: false })
    }
  },

  goMatch(matchId) {
    if (!matchId) return
    wx.navigateTo({
      url: `/pages/match/match?match_id=${encodeURIComponent(matchId)}`,
    })
  },

    async startChallenge() {
    if (this.data.cooldownLeftSec > 0) {
      wx.showToast({ title: `闁告劕鍢插畵鍫熺▔?${this.data.cooldownLeftSec}s`, icon: 'none' })
      return
    }

    if (this.data.dailyLimitReached) {
      wx.showToast({ title: 'daily limit reached', icon: 'none' })
      return
    }

    if (this.data.activeMatchId) {
      this.goMatch(this.data.activeMatchId)
      return
    }

    if (!this.data.latest) {
      wx.showToast({ title: '婵繐绲藉﹢顏嗙驳婢跺﹦绐￠悹浣瑰劤椤︻剟寮悧鍫濈ウ', icon: 'none' })
      return
    }
    if (!this.data.latestView.isFresh) {
      wx.showToast({ title: 'waiting for fresh data', icon: 'none' })
      return
    }
    const currentPollen = Number(this.data.latest && this.data.latest.pollen_value)
    if (!Number.isFinite(currentPollen) || currentPollen < 60) {
      wx.showToast({ title: 'threshold not met (>=60 required)', icon: 'none' })
      return
    }

    this.setData({ starting: true, lastError: '' })
    console.log('[index] startMatch params:', {
      userOpenid: this.data.userOpenid,
      nickname: this.data.nickname,
      deviceId: this.data.deviceId,
    })
    try {
      const res = await api.startMatch({
        userOpenid: this.data.userOpenid,
        nickname: this.data.nickname,
        deviceId: this.data.deviceId,
      })
      this.goMatch(res.match.match_id)
    } catch (e) {
      if (e.code === 'ACTIVE_MATCH_EXISTS') {
        const activeMatch = e.payload && e.payload.active_match
        if (activeMatch && activeMatch.match_id) {
          this.setData({ activeMatchId: activeMatch.match_id })
          this.goMatch(activeMatch.match_id)
          return
        }
      }

      if (e.code === 'COOLDOWN_NOT_REACHED') {
        const retryAfterSec =
          (e.payload && e.payload.error && e.payload.error.retry_after_sec) || 0
        if (retryAfterSec > 0) {
          this.startCooldown(retryAfterSec)
          wx.showToast({ title: `闁告劕鍢插畵鍫熺▔?${retryAfterSec}s`, icon: 'none' })
          return
        }
      }

      if (e.code === 'DAILY_LIMIT_REACHED') {
        this.setData({ dailyLimitReached: true })
        wx.showToast({ title: 'daily limit reached', icon: 'none' })
        return
      }

      if (e.code === 'START_THRESHOLD_NOT_MET') {
        wx.showToast({ title: 'threshold not met (>=60 required)', icon: 'none' })
        return
      }

      const msg = formatError(e, '鐎殿喒鍋撳┑顔碱儐鐎殿偊骞嬪Ο鎭掍杭閻犳劑鍎荤槐婵堟嫚妞嬪簶妫﹂柛姘叄閸ｅ摜鎷?')
      wx.showToast({ title: msg, icon: 'none', duration: 2200 })
      this.setData({ lastError: msg })
    } finally {
      this.setData({ starting: false })
    }
  },  async stopActiveMatch() {
    if (!this.data.activeMatchId) return

    this.setData({ stopping: true, lastError: '' })
    try {
      await api.stopMatch({
        matchId: this.data.activeMatchId,
        endReason: 'MANUAL_STOP_FROM_HOME',
      })
      wx.showToast({ title: 'match stopped', icon: 'none' })
      await this.refreshHome()
    } catch (e) {
      this.setData({ lastError: formatError(e, 'stop failed, retry later') })
    } finally {
      this.setData({ stopping: false })
    }
  },

  openMonthlyBoard() {
    if (!this.data.userOpenid) {
      wx.showToast({ title: 'please login first', icon: 'none' })
      setTimeout(() => {
        wx.navigateTo({ url: '/pages/login/login' })
      }, 500)
      return
    }

    wx.navigateTo({
      url: '/pages/logs/logs',
      fail: (err) => {
        console.error('[index] failed to navigate to logs', err)
        wx.showToast({ title: 'open page failed', icon: 'none' })
      },
    })
  },

  openMyRecords() {
    if (this.data.activeMatchId) {
      this.goMatch(this.data.activeMatchId)
      return
    }
    const firstEnded = this.data.recentMatches.find((x) => x.status !== 'active')
    if (firstEnded && firstEnded.match_id) {
      wx.navigateTo({
        url: `/pages/result/result?match_id=${encodeURIComponent(firstEnded.match_id)}`,
      })
      return
    }
    wx.showToast({ title: 'no records yet', icon: 'none' })
  },

  showRules() {
    const soundStateText = this.data.soundEnabled ? 'on' : 'off'
    wx.showModal({
      title: 'Rules',
      content:
        'Move to lower concentration areas for higher score.\n' +
        'Start threshold: concentration >= 60.\n' +
        'Speaker sound: ' + soundStateText + '.',
      showCancel: false,
    })
  },

  changeNickname() {
    wx.showModal({
      title: 'Change Nickname',
      editable: true,
      placeholderText: 'Enter nickname',
      content: this.data.nickname,
      success: async (res) => {
        if (res.confirm && res.content) {
          const newNickname = res.content.trim().slice(0, 12)
          if (!newNickname) return

          try {
            await api.updateUserProfile({
              userOpenid: this.data.userOpenid,
              nickname: newNickname,
            })
            wx.setStorageSync('nickname', newNickname)
            this.setData({ nickname: newNickname })
            wx.showToast({ title: 'updated', icon: 'success' })
            this.refreshHome()
          } catch (e) {
            wx.showToast({ title: 'update failed', icon: 'none' })
          }
        }
      },
    })
  },

  syncTestMode() {
    const app = getApp()
    const useShared = app.getUseSharedTestOpenid ? app.getUseSharedTestOpenid() : true
    const userOpenid = wx.getStorageSync('user_openid') || ''

    this.setData({
      userOpenid,
      testModeText: useShared ? 'shared test account' : 'independent account',
    })

    this.refreshHome()
  },

  openDebugSettings() {
    const app = getApp()
    const useShared = app.getUseSharedTestOpenid ? app.getUseSharedTestOpenid() : true

    const itemList = useShared
      ? ['switch to independent account', 'reset and regenerate independent account']
      : ['switch to shared account', 'keep current independent account']

    wx.showActionSheet({
      itemList,
      success: ({ tapIndex }) => {
        let nextModeText = this.data.testModeText
        if (useShared) {
          if (tapIndex === 0) {
            app.setUseSharedTestOpenid(false)
            nextModeText = 'independent account'
          } else if (tapIndex === 1) {
            app.setUseSharedTestOpenid(false, { regenerateIndependent: true })
            nextModeText = 'independent account'
          }
        } else if (tapIndex === 0) {
          app.setUseSharedTestOpenid(true)
          nextModeText = 'shared account'
        }

        this.syncTestMode()
        wx.showToast({ title: 'switched: ' + nextModeText, icon: 'none' })
        setTimeout(() => {
          wx.reLaunch({ url: '/pages/index/index' })
        }, 280)
      },
    })
  },

  async onSoundSwitchChange(e) {
    const soundEnabled = !!e.detail.value
    const prevEnabled = !!this.data.soundEnabled
    const deviceId = this.data.deviceId || wx.getStorageSync('device_id') || app.globalData.defaultDeviceId

    this.setData({ soundEnabled })
    app.setSoundEnabled(soundEnabled)

    try {
      if (deviceId) {
        await api.setDeviceSound({ deviceId, soundEnabled })
      }
      wx.showToast({ title: soundEnabled ? 'sound on' : 'sound off', icon: 'success' })
    } catch (err) {
      this.setData({ soundEnabled: prevEnabled })
      app.setSoundEnabled(prevEnabled)
      wx.showToast({ title: 'device sync failed', icon: 'none' })
    }
  },

  startCooldown(seconds) {
    const sec = Math.max(0, Number(seconds) || 0)
    this.setData({ cooldownLeftSec: sec })
    this.clearCooldownTimer()
    if (sec <= 0) {
      wx.removeStorageSync(KEY_HOME_COOLDOWN_UNTIL)
      return
    }

    const cooldownUntilMs = Date.now() + sec * 1000
    wx.setStorageSync(KEY_HOME_COOLDOWN_UNTIL, cooldownUntilMs)

    this._cooldownTimer = setInterval(() => {
      const next = this.data.cooldownLeftSec - 1
      if (next <= 0) {
        this.clearCooldownTimer()
        this.setData({ cooldownLeftSec: 0 })
        wx.removeStorageSync(KEY_HOME_COOLDOWN_UNTIL)
        return
      }
      this.setData({ cooldownLeftSec: next })
    }, 1000)
  },

  restoreCooldownFromStorage() {
    const cooldownUntilMs = Number(wx.getStorageSync(KEY_HOME_COOLDOWN_UNTIL) || 0)
    const remainSec = Math.max(0, Math.ceil((cooldownUntilMs - Date.now()) / 1000))
    if (remainSec > 0) {
      this.startCooldown(remainSec)
      return
    }
    this.clearCooldownTimer()
    this.setData({ cooldownLeftSec: 0 })
    wx.removeStorageSync(KEY_HOME_COOLDOWN_UNTIL)
  },

  clearCooldownTimer() {
    if (this._cooldownTimer) {
      clearInterval(this._cooldownTimer)
      this._cooldownTimer = null
    }
  },

  clearGaugeTimer() {
    if (this._gaugeTimer) {
      clearInterval(this._gaugeTimer)
      this._gaugeTimer = null
    }
  },

  // 1. 濞ｅ浂鍠楅弫濂告晬濮橆剙娅欏璺烘川閺佸墽鏁崘鈺傤槯闁挎稑鑻·鍐礉閻樻彃鐏ュ┑顔碱儏鐎?2D Canvas 闁汇劌瀚惃鐔兼偨?
  prepareGaugeCanvas() {
    let width = 230
    try {
      const w = wx.getWindowInfo().windowWidth
      width = Math.max(220, Math.min(320, Math.floor(w * 0.74)))
    } catch (e) {
      width = 230
    }
    const height = Math.floor(width * 0.56)
    this.setData(
      {
        gaugeWidth: width,
        gaugeHeight: height,
        gaugeStyle: `width:${width}px;height:${height}px;`,
        gaugeWrapStyle: `width:${width}px;height:${height}px;`,
      },
      () => {
        // 闁稿繑濞婇弫顓㈠绩閻熸澘袟闁挎稒姘ㄩ悺鎴濐嚗?WXML 婵炴挸寮堕悡瀣偓鐟拌嫰閹鏁嶇仦钘夋櫃闁告顕ч崹鍨叏鐎ｎ亜顕?2D 闁汇垼顕х粩?
        wx.nextTick(() => this.initCanvas2D())
      }
    )
  },

  // 2. 闁哄倹婢橀·鍐晬濮橆剙鐏ュ┑顔碱儏鐎?2D Canvas 闁汇劌瀚崵閬嶅极?
  initCanvas2D() {
    const query = wx.createSelectorQuery()
    query.select('#homeGaugeCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res[0] || !res[0].node) return
        const canvas = res[0].node
        const ctx = canvas.getContext('2d')
        const dpr = wx.getWindowInfo().pixelRatio || 2
        
        canvas.width = res[0].width * dpr
        canvas.height = res[0].height * dpr
        ctx.scale(dpr, dpr)
        
        // 闁硅泛锕ら悿鍕瑹鐎ｎ亞鎽犻悹褔鏀卞鐢告晬鐏為棿绨伴柛姘捣閺侀箖宕濋妸褎鏆伴悘蹇撳綁缁楀鎮介妸鈺佹濠㈣泛绉烽獮蹇涘矗閺嶏妇鍟?
        this._canvasNode = canvas
        this._canvasCtx = ctx
        
        this.drawHomeGauge(this.data.latestView)
      })
  },

  // 闁硅泛锕ㄧ换鏍р枔娴ｅ叝澶愬捶?drawHomeGauge 闁汇劌瀚粭鍌炲棘閻у摜纾?
  animateGaugeTo(latestView) {
    const view = latestView || this.data.latestView || buildLatestView(null)
    const target = clamp(Number(view.meterWidth || 0) / 100, 0, 1)
    const start = typeof this._gaugeProgress === 'number' ? this._gaugeProgress : 0
    const diff = Math.abs(target - start)

    if (diff < 0.006) {
      this._gaugeProgress = target
      this.drawHomeGauge(view, target)
      return
    }

    this.clearGaugeTimer()
    const durationMs = 460
    const stepMs = 16
    const totalSteps = Math.max(1, Math.floor(durationMs / stepMs))
    let step = 0

    this._gaugeTimer = setInterval(() => {
      step += 1
      const t = Math.min(1, step / totalSteps)
      // 缂傚倹鎸告慨鈺呭礉閵娧勬毎缂佺姵顨嗙涵?
      const eased = 1 - Math.pow(1 - t, 3)
      const p = start + (target - start) * eased
      this.drawHomeGauge(view, p)
      if (t >= 1) {
        this.clearGaugeTimer()
        this._gaugeProgress = target
      }
    }, stepMs)
  },
  // 3. 鐟滄媽顕х花鎶芥煂瀹ュ懎鏅搁柨娑欑煯婵炲洭鎮?2D 閻犲浂鍘界涵鍫曟煂瀹ュ洨甯涘ù鐙€浜ｉ妴鍐儎濮楀牏绀夋鐐舵硾婵偞绋夋繝鍐╊唫闁肩灏粋宀勫础濮橆厽绠欓柛蹇擃儎鐎靛本锛?
  drawHomeGauge(latestView, progressOverride) {
    if (!this._canvasCtx || !this._canvasNode) return
    const ctx = this._canvasCtx
    const w = this.data.gaugeWidth
    const h = this.data.gaugeHeight

    const view = latestView || this.data.latestView || buildLatestView(null)
    const progress =
      typeof progressOverride === 'number'
        ? clamp(progressOverride, 0, 1)
        : clamp(Number(view.meterWidth || 0) / 100, 0, 1)
    const color = getGaugeColor(view.level)

    // 婵炴挸鎳愰埞鏍偨鐠囪尙顏?
    ctx.clearRect(0, 0, w, h)

    const centerX = w / 2
    const centerY = h - 8
    const radius = Math.max(20, Math.min((w - 24) / 2, h - 18))

    const gradient = ctx.createLinearGradient(0, centerY - radius, w, centerY - radius)
    if (view.level === LEVEL.HIGH) {
      gradient.addColorStop(0, '#FF8F9A')
      gradient.addColorStop(1, '#FF6F7D')
    } else if (view.level === LEVEL.MID) {
      gradient.addColorStop(0, '#FFD3A5')
      gradient.addColorStop(1, '#FF9F45')
    } else {
      gradient.addColorStop(0, '#86E3C3')
      gradient.addColorStop(1, '#2FC68F')
    }
    ctx.lineCap = 'round'
    // --- 1. 閹煎瓨娲栭惇鐗堟姜閵娾晙澹曢柨娑欎亢閻ㄧ喓绱掗崱顓犵妤犵偞婀规繛鍥偨閵婏附绾繛锝勭┒閳ь兛鐒﹀ú鍧楁焻濮樺灈鍋撹箛鏇熺暠濡増绮忔竟?---
    ctx.lineWidth = 8; // 濞?14 閻犲鍟扮划蹇涘礆?8
    ctx.strokeStyle = 'rgba(58, 61, 74, 0.5)'; // 濞达綀娉曢弫銈夊础婵犲洠鍋撹箛鏃€顫栨繛锝堜含娴煎棝鎳濈拠褏绀夊褏鍋涙慨鐐哄灳濠婂啯鍤戦柛姘啞閸斿懘鍨?
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, Math.PI, 0, false);
    ctx.stroke();

    // --- 2. 婵炲弶妲掔粚顒佹交濞戞ê顔婇柡澶嗘缁辩増绌卞┑鍥х槷閻庣妫勭€规娊鏁嶇仦鍊熷珯濠⒀呭仜婵偤鍨惧鍫熺闁惧繒鎳撻ˇ濠氬矗閹存繂甯ㄩ柍銉︾箘婢规帡寮?---
    ctx.lineWidth = 14; 
    ctx.strokeStyle = gradient; // 閺夆晜鐟╅崳鐑芥儍?color 濞村吋纰嶉悧鎾箲椤旂晫銈块幖杈剧畳閸ゆ粓宕濋妸銉ョ€奸柟骞垮灮鐠?婵?缂?

    // 闂佹彃绉堕崑锝夋晬濮橆剛纾婚柛?Canvas 闁汇劌瀚ˇ濠氬矗閹存繂甯ㄩ梻鍐╂綑婵?
    ctx.shadowBlur = 15; // 闁告瑦鍨甸崢婊兾熼敍鍕囬柛妤€锕ょ欢?
    ctx.shadowColor = color; // 闁告瑦鍨甸崢婊勶紣濠婂棗顥忓☉鎾虫捣閸ゅ酣寮堕敓鐙€鏉归柤纭呭紦缁旀挳鎳?

    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, Math.PI, Math.PI * (1 - progress), false);
    ctx.stroke();

    // 闁稿繑濞婇弫顓㈡晬濮樿鲸鏆伴悗鐟拌嫰瑜板倿宕楁径瀣拫闁告艾鍑界槐婵婄疀閸涙番鈧繒绮╃€ｎ亜绁梺鎻掔Ф閻ゅ棝姊奸弶鎴濐殯闁挎稑鑻幆渚€宕氬▎搴ｇ獥鐟滄澘宕幖鐑藉触鎼达絿鏁鹃柡鍌氭搐閻⊙囧椽瀹€鍐彾婵?
    ctx.shadowBlur = 0;

    // --- 3. 闁告劕鎳庡﹢鈧紓浣告閸ゅ酣鏁嶅顒夋澔鐎殿喛娅ｉ～鏍箮閳ь剟骞囬悤鍌滅濞达絽绉堕悿鍡欑矙瀹ュ洠妫︾€垫壋鍋撻梺鎻掓湰鐏忔挻绋夐埀顒勬倷?---
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'; // 闂侇偄绻戝Σ鎴炴償閿旈敮妫︾€甸偊鍠涢惃鐔割殗濡湱顏遍柣?
    ctx.lineWidth = 2;
    ctx.beginPath();
    // 閺夆晜鐟╅崳鐑芥儍?radius - 15 閻犱讲鏅濈划蹇曠棯閸喗瀚插☉鎾存缁绘ɑ鎯旈敂鑺ヨ拫濞戞柨顑夊Λ鍧楁偩濞嗗繐姣夌紒灞炬そ濞堫參鏁嶇仦鐐函闁哄牆顦惇鏉库枎?
    ctx.arc(centerX, centerY, radius - 15, Math.PI, 0, false);
    ctx.stroke();
    
    // 婵炲鍔嶉崜浼存晬?D 闁汇垼顕х粩閿嬬▔瀹ュ浠橀悷鏇氱閸?ctx.draw()闁挎稑鐬奸弫鍓р偓鐟扮焷閸ゆ粌顔忛崡鐐寸殤闁告垹鍎ゅ鍨閸☆厾纾?
  },
})

