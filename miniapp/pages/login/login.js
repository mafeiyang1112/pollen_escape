const api = require('../../utils/api')
const app = getApp()

Page({
  data: {
    loading: false,
    lastError: '',
    openid: '',
    nickname: '',
    avatarUrl: '',
    useShared: false,
    loginMode: 'wechat',
  },

  async _doLogin({ forceProfile = false } = {}) {
    this.setData({ loading: true, lastError: '' })

    try {
      const useShared = app.getUseSharedTestOpenid ? app.getUseSharedTestOpenid() : false

      if (this.data.openid && !useShared && !forceProfile) {
        this._saveUserInfo()
        wx.showToast({ title: '登录成功', icon: 'success' })
        setTimeout(() => this.goToIndex(), 280)
        return
      }

      const openid = await app.login()
      let nickname = ''
      let avatarUrl = ''

      if (useShared) {
        nickname = ''
        avatarUrl = ''
      }

      this.setData({
        openid,
        useShared,
        loginMode: useShared ? 'shared' : 'wechat',
        nickname,
        avatarUrl,
      })

      if (useShared) {
        // 共享账号直接登录
        this._saveUserInfo()
        wx.showToast({ title: '登录成功', icon: 'success' })
        setTimeout(() => this.goToIndex(), 280)
      } else {
        // 微信登录跳转到头像昵称设置页面
        wx.navigateTo({
          url: `/pages/profile/profile?openid=${openid}`,
          success: () => {
            console.log('[login] navigate to profile page')
          },
          fail: (err) => {
            console.error('[login] navigate to profile failed', err)
            // 如果跳转失败，使用默认信息登录
            this._saveUserInfo()
            this.goToIndex()
          }
        })
      }
    } catch (e) {
      console.error('[login] login failed', e)
      let msg = e.message || '登录失败，请检查网络后重试'
      if (String(msg).includes('invalid code') || String(e.code || '').includes('WX_AUTH_40029')) {
        msg = '微信登录码无效（常见于开发者工具）。请用真机预览测试，或重试一次。'
      }
      this.setData({
        lastError: msg,
      })
      wx.showToast({ title: msg, icon: 'none', duration: 2600 })
    } finally {
      this.setData({ loading: false })
    }
  },

  async onWechatLoginTap() {
    if (this.data.loading) return
    this.setData({ loginMode: 'wechat' })
    
    try {
      app.setUseSharedTestOpenid(false)
      this._refreshModeState()
      await this._doLogin({ forceProfile: true })
    } catch (e) {
      console.error('[login] WeChat login failed', e)
      wx.showToast({ title: '登录失败，请重试', icon: 'none' })
    }
  },

  async onSharedLoginTap() {
    if (this.data.loading) return
    this.setData({ loginMode: 'shared' })
    app.setUseSharedTestOpenid(true)
    this._refreshModeState()
    await this._doLogin()
  },

  _saveUserInfo() {
    wx.setStorageSync('user_openid', this.data.openid)
    wx.setStorageSync('nickname', this.data.nickname)
    wx.setStorageSync('avatarUrl', this.data.avatarUrl)

    app.globalData.userOpenid = this.data.openid
    app.globalData.userNickname = this.data.nickname
    app.globalData.userAvatarUrl = this.data.avatarUrl
  },

  goToIndex() {
    wx.reLaunch({
      url: '/pages/index/index',
    })
  },

  onLoad() {
    this._refreshModeState()
  },

  _refreshModeState() {
    const useShared = app.getUseSharedTestOpenid ? app.getUseSharedTestOpenid() : false
    const openid = app.globalData.userOpenid || wx.getStorageSync('user_openid') || ''
    const nickname = wx.getStorageSync('nickname') || ''
    const avatarUrl = wx.getStorageSync('avatarUrl') || ''

    this.setData({
      useShared,
      openid,
      nickname,
      avatarUrl,
      loginMode: useShared ? 'shared' : 'wechat',
    })
  },
})
