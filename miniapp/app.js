﻿﻿﻿﻿﻿const api = require('./utils/api')

const LOCAL_API_BASE_URL = 'https://btaknzxzeczz.sealoshzh.site'
const LAN_API_BASE_URL = 'https://btaknzxzeczz.sealoshzh.site'
const SHARED_TEST_OPENID = 'dev_shared_esp32_001'
const DEFAULT_USE_SHARED_TEST_OPENID = false
const KEY_USER_OPENID = 'user_openid'
const KEY_INDEPENDENT_OPENID = 'independent_user_openid'
const KEY_USE_SHARED_TEST_OPENID = 'use_shared_test_openid'
const KEY_SHARED_MODE_MIGRATED = 'shared_mode_migrated_v2'
const KEY_API_BASE_URL = 'api_base_url'
const KEY_SOUND_ENABLED = 'sound_enabled'

function normalizeSharedMode(value) {
  return typeof value === 'boolean' ? value : DEFAULT_USE_SHARED_TEST_OPENID
}

function isPseudoOpenid(openid) {
  const v = String(openid || '').trim()
  return v.startsWith('user_') || v.startsWith('dev_')
}

function getRuntimePlatform() {
  try {
    const base = wx.getAppBaseInfo && wx.getAppBaseInfo()
    if (base && base.platform) return base.platform
  } catch (e) {
    // fallback below
  }
  try {
    const sys = wx.getSystemInfoSync && wx.getSystemInfoSync()
    if (sys && sys.platform) return sys.platform
  } catch (e) {
    // ignored
  }
  return ''
}

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/$/, '')
}

function isHttpBaseUrl(url) {
  const value = normalizeBaseUrl(url)
  return value.startsWith('http://') || value.startsWith('https://')
}

App({
  _applyRuntimeConfig() {
    const platform = getRuntimePlatform()
    const storedSharedMode = wx.getStorageSync(KEY_USE_SHARED_TEST_OPENID)
    let useSharedMode = normalizeSharedMode(storedSharedMode)
    const sharedModeMigrated = !!wx.getStorageSync(KEY_SHARED_MODE_MIGRATED)

    // One-time migration: real devices use independent account mode by default.
    if (platform !== 'devtools' && !sharedModeMigrated) {
      useSharedMode = false
      wx.setStorageSync(KEY_USE_SHARED_TEST_OPENID, false)
      wx.setStorageSync(KEY_SHARED_MODE_MIGRATED, true)
    }

    let openid = ''
    if (useSharedMode) {
      openid = SHARED_TEST_OPENID
      wx.setStorageSync(KEY_USER_OPENID, openid)
    } else {
      openid = wx.getStorageSync(KEY_INDEPENDENT_OPENID)
      if (!openid) {
        const storedOpenid = wx.getStorageSync(KEY_USER_OPENID)
        if (storedOpenid && storedOpenid !== SHARED_TEST_OPENID) {
          openid = storedOpenid
        }
      }
      if (isPseudoOpenid(openid)) {
        openid = ''
      }
      if (!openid) {
        openid = ''
        wx.removeStorageSync(KEY_INDEPENDENT_OPENID)
        wx.removeStorageSync(KEY_USER_OPENID)
      } else {
        wx.setStorageSync(KEY_INDEPENDENT_OPENID, openid)
        wx.setStorageSync(KEY_USER_OPENID, openid)
      }
    }

    const customApiBaseUrl = normalizeBaseUrl(wx.getStorageSync(KEY_API_BASE_URL))

    const isDevtools = platform === 'devtools'

    let apiBaseUrl = ''
    if (isHttpBaseUrl(customApiBaseUrl)) {
      apiBaseUrl = customApiBaseUrl
    } else if (isDevtools) {
      apiBaseUrl = LOCAL_API_BASE_URL
    } else {
      apiBaseUrl = LAN_API_BASE_URL
    }

    this.globalData.apiBaseUrl = apiBaseUrl
    this.globalData.userOpenid = openid
    this.globalData.useSharedTestOpenid = useSharedMode
    this.globalData.soundEnabled = wx.getStorageSync(KEY_SOUND_ENABLED) !== false // 默认开启
    if (useSharedMode) {
      // Shared mode must not carry over personal WeChat profile cache.
      this.globalData.wechatNickname = ''
      this.globalData.wechatAvatarUrl = ''
    }
    console.info(
      '[app] apiBaseUrl=%s platform=%s user_openid=%s shared_mode=%s sound_enabled=%s',
      apiBaseUrl,
      platform || 'unknown',
      openid,
      useSharedMode ? 'on' : 'off',
      this.globalData.soundEnabled ? 'on' : 'off'
    )
  },

  login() {
    return new Promise((resolve, reject) => {
      if (this.getUseSharedTestOpenid()) {
        this.globalData.wechatNickname = ''
        this.globalData.wechatAvatarUrl = ''
        resolve(this.globalData.userOpenid)
        return
      }

      // WeChat profile should be captured in the tap handler before async flow.
      if (!this.globalData.wechatNickname) this.globalData.wechatNickname = ''
      if (!this.globalData.wechatAvatarUrl) this.globalData.wechatAvatarUrl = ''

      wx.login({
        success: async (loginRes) => {
          const code = String((loginRes && loginRes.code) || '').trim()
          if (!code) {
            reject(new Error('微信登录失败：未获取到 code'))
            return
          }
          try {
            const wxResult = await api.wxLogin(code)
            const openid = String((wxResult && wxResult.openid) || '').trim()
            if (!openid) {
              throw new Error('后端未返回微信 openid')
            }
            wx.setStorageSync(KEY_INDEPENDENT_OPENID, openid)
            wx.setStorageSync(KEY_USER_OPENID, openid)
            this.globalData.userOpenid = openid
            resolve(openid)
          } catch (e) {
            const ex = new Error((e && e.message) || '微信登录失败，请重试')
            ex.code = e && e.code
            reject(ex)
          }
        },
        fail: (err) => {
          reject(new Error((err && err.errMsg) || '微信登录调用失败'))
        },
      })
    })
  },

  onLaunch() {
    this._applyRuntimeConfig()
  },

  setUseSharedTestOpenid(useSharedMode, { regenerateIndependent } = {}) {
    const prevMode = this.getUseSharedTestOpenid()
    wx.setStorageSync(KEY_USE_SHARED_TEST_OPENID, !!useSharedMode)
    if (useSharedMode) {
      const currentOpenid = String(wx.getStorageSync(KEY_USER_OPENID) || '').trim()
      if (currentOpenid && currentOpenid !== SHARED_TEST_OPENID && !isPseudoOpenid(currentOpenid)) {
        wx.setStorageSync(KEY_INDEPENDENT_OPENID, currentOpenid)
      }
    } else if (regenerateIndependent) {
      wx.removeStorageSync(KEY_INDEPENDENT_OPENID)
    }

    if (useSharedMode && !prevMode) {
      // Clear local profile only when switching from independent to shared.
      wx.removeStorageSync('nickname')
      wx.removeStorageSync('avatarUrl')
      this.globalData.wechatNickname = ''
      this.globalData.wechatAvatarUrl = ''
    }
    this._applyRuntimeConfig()
  },

  getUseSharedTestOpenid() {
    return normalizeSharedMode(wx.getStorageSync(KEY_USE_SHARED_TEST_OPENID))
  },

  setSoundEnabled(enabled) {
    const value = !!enabled
    wx.setStorageSync(KEY_SOUND_ENABLED, value)
    this.globalData.soundEnabled = value
    console.info('[app] sound_enabled=%s', value ? 'on' : 'off')
  },

  getSoundEnabled() {
    return this.globalData.soundEnabled
  },

  globalData: {
    apiBaseUrl: LOCAL_API_BASE_URL,
    defaultDeviceId: 'esp32-s3-real-001',
    userOpenid: '',
    useSharedTestOpenid: DEFAULT_USE_SHARED_TEST_OPENID,
    wechatNickname: '',
    wechatAvatarUrl: '',
    userNickname: '',
    userAvatarUrl: '',
    soundEnabled: true, // 声音开关默认开启
  },
})
