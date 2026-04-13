const api = require('../../utils/api')

const DEFAULT_AVATAR = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'

Page({
  data: {
    leaderboard: [],
    userProfile: null,
    userOpenid: '',
    currentMonth: '',
    loading: true,
    lastError: '',
    DefaultAvatar: DEFAULT_AVATAR
  },

  onLoad() {
    const app = getApp()
    // 优先从 globalData 获取，再从本地存储获取
    const userOpenid = app.globalData.userOpenid || wx.getStorageSync('user_openid') || ''
    const currentMonth = this._getCurrentMonth()

    console.log('[logs] onLoad: userOpenid=', userOpenid)
    console.log('[logs] onLoad: currentMonth=', currentMonth)

    if (!userOpenid) {
      console.error('[logs] onLoad: userOpenid is empty')
      this.setData({ 
        lastError: '未登录，请先登录',
        loading: false
      })
      return
    }

    this.setData({
      userOpenid,
      currentMonth,
      DefaultAvatar: DEFAULT_AVATAR,
      loading: true,
      lastError: ''
    })

    // 延迟加载以确保UI已经更新
    wx.nextTick(() => {
      this.loadLeaderboard()
    })
  },

  onShow() {
    const app = getApp()
    const userOpenid = app.globalData.userOpenid || wx.getStorageSync('user_openid') || ''
    
    if (userOpenid && userOpenid === this.data.userOpenid) {
      // 相同用户，刷新数据
      this.loadLeaderboard()
    } else if (userOpenid) {
      // 用户变更（比如切换了账号），重新初始化
      this.setData({ userOpenid })
      this.loadLeaderboard()
    }
  },

  onPullDownRefresh() {
    this.loadLeaderboard().finally(() => wx.stopPullDownRefresh())
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  },

  async loadLeaderboard() {
    const userOpenid = this.data.userOpenid
    if (!userOpenid) {
      console.warn('[logs] loadLeaderboard: userOpenid is empty')
      this.setData({ 
        lastError: '未登录，请先登录',
        loading: false
      })
      return
    }

    this.setData({ loading: true, lastError: '' })
    console.log('[logs] starting to load leaderboard for:', userOpenid, 'month:', this.data.currentMonth)

    try {
      console.log('[logs] calling api.getMonthlyLeaderboard...')
      const leaderboardRes = await api.getMonthlyLeaderboard(100)
      console.log('[logs] leaderboardRes success:', leaderboardRes)

      console.log('[logs] calling api.getUserProfile...')
      const profileRes = await api.getUserProfile(userOpenid, this.data.currentMonth)
      console.log('[logs] profileRes success:', profileRes)

      const leaderboard = leaderboardRes.leaderboard || []
      const userProfile = profileRes
      
      console.log('[logs] leaderboard count:', leaderboard.length)
      console.log('[logs] userProfile:', userProfile)

      // Ensure monthly data structure exists
      if (userProfile && !userProfile.monthly) {
        userProfile.monthly = {
          total_score: 0,
          valid_matches: 0,
          best_match_score: 0,
          rank: '--'
        }
      }

      // Find user's rank
      if (userProfile && userProfile.monthly && leaderboard.length > 0) {
        const userRank = leaderboard.findIndex(item => item.user_openid === userOpenid)
        if (userRank >= 0) {
          userProfile.monthly.rank = userRank + 1
          console.log('[logs] user rank:', userRank + 1)
        }
      }

      // Add rank to leaderboard
      const boardWithRank = leaderboard.map((item, index) => ({
        ...item,
        rank: index + 1
      }))

      // 处理头像 URL，只保留有效的远程 URL
      const processedBoard = boardWithRank.map(item => {
        const avatarUrl = item.avatar_url || ''
        const isValidRemote = avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')
        console.log(`[logs] avatar check: ${item.nickname}, url=${avatarUrl.substring(0, 50)}..., valid=${isValidRemote}`)
        return {
          ...item,
          avatar_url: isValidRemote ? avatarUrl : ''
        }
      })

      console.log('[logs] final data update:', {
        leaderboardCount: processedBoard.length,
        hasUserProfile: !!userProfile,
        DefaultAvatar: this.data.DefaultAvatar
      })

      this.setData({
        leaderboard: processedBoard,
        userProfile,
        lastError: '',
        loading: false
      })
    } catch (e) {
      console.error('[logs] failed to load leaderboard:', e)
      const errorMsg = e.message || e.code || '加载失败，请稍后重试'
      this.setData({
        lastError: errorMsg,
        loading: false
      })
    }
  },

  _getCurrentMonth() {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    return `${year}-${month}`
  }
})


