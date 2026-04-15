const api = require('../../utils/api')
const app = getApp()

function normalizeUploadedAvatarUrl(url, apiBaseUrl) {
  const value = String(url || '').trim()
  if (!value) return ''

  // If backend returns http behind a proxy while app uses https, upgrade URL for mini program image loading.
  if (value.startsWith('http://') && String(apiBaseUrl || '').startsWith('https://')) {
    return `https://${value.slice('http://'.length)}`
  }
  return value
}

Page({
  data: {
    openid: '',
    nickname: '',
    avatarUrl: '',
    loading: false,
    lastError: '',
  },

  onLoad(options) {
    const openid = options.openid || ''
    if (!openid) {
      wx.showToast({ title: '缺少必要参数', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1000)
      return
    }
    this.setData({ openid })
  },

  async onChooseAvatar(e) {
    const { avatarUrl: tempAvatarUrl } = e.detail

    if (!this.data.openid || !tempAvatarUrl) {
      wx.showToast({ title: '未获取到头像文件', icon: 'none' })
      return
    }

    try {
      wx.showLoading({ title: '上传头像中...' })
      const result = await api.uploadAvatar({
        filePath: tempAvatarUrl,
        userOpenid: this.data.openid,
      })

      if (result && result.ok) {
        const apiBaseUrl = app.globalData && app.globalData.apiBaseUrl
        const newAvatarUrl = normalizeUploadedAvatarUrl(result.avatar_url, apiBaseUrl)

        if (!newAvatarUrl) {
          throw new Error('服务器未返回可用头像地址')
        }

        this.setData({ avatarUrl: newAvatarUrl })
        wx.setStorageSync('avatarUrl', newAvatarUrl)
        app.globalData.userAvatarUrl = newAvatarUrl

        await api.updateUserProfile({
          userOpenid: this.data.openid,
          avatarUrl: newAvatarUrl,
        })
        wx.showToast({ title: '头像上传成功', icon: 'success' })
      } else {
        wx.showToast({ title: '头像上传失败', icon: 'none' })
      }
    } catch (err) {
      console.error('[profile] upload avatar failed', err)
      const msg = (err && err.message) ? String(err.message).slice(0, 28) : '头像上传失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  async onNicknameBlur(e) {
    const nickname = (e.detail.value || '').trim()
    this.setData({ nickname })
    if (!nickname || !this.data.openid) return

    try {
      await api.updateUserProfile({
        userOpenid: this.data.openid,
        nickname,
      })
      wx.setStorageSync('nickname', nickname)
      wx.showToast({ title: '昵称更新成功', icon: 'success' })
    } catch (err) {
      console.error('[profile] update nickname failed', err)
      if (err.statusCode === 409 || err.code === 'NICKNAME_ALREADY_TAKEN') {
        wx.showToast({ title: '昵称已被占用', icon: 'none', duration: 2000 })
        this.setData({ nickname: '' })
      } else {
        wx.showToast({ title: '昵称更新失败，请重试', icon: 'none' })
      }
    }
  },

  async onComplete() {
    this.setData({ loading: true, lastError: '' })

    try {
      const { openid, nickname, avatarUrl } = this.data

      if (nickname || avatarUrl) {
        try {
          await api.updateUserProfile({
            userOpenid: openid,
            nickname,
            avatarUrl,
          })
        } catch (err) {
          console.error('[profile] updateUserProfile failed', err)
        }
      }

      wx.setStorageSync('user_openid', openid)
      if (nickname) wx.setStorageSync('nickname', nickname)
      if (avatarUrl) wx.setStorageSync('avatarUrl', avatarUrl)

      app.globalData.userOpenid = openid
      app.globalData.userNickname = nickname
      app.globalData.userAvatarUrl = avatarUrl

      wx.showToast({ title: '设置成功', icon: 'success' })
      setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 1000)
    } catch (err) {
      console.error('[profile] complete failed', err)
      this.setData({ lastError: '设置失败，请重试' })
      wx.showToast({ title: '设置失败，请重试', icon: 'none' })
      setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 1000)
    } finally {
      this.setData({ loading: false })
    }
  },

  onSkip() {
    const { openid } = this.data

    wx.setStorageSync('user_openid', openid)
    app.globalData.userOpenid = openid

    wx.showToast({ title: '跳过设置', icon: 'none' })
    setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 500)
  },
})
