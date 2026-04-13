const DEFAULT_LOCAL_API_BASE_URL = 'http://127.0.0.1:5000'
const DEFAULT_LAN_API_BASE_URL = 'http://10.104.85.85:5000'
const REQUEST_TIMEOUT_MS = 5000
const PROBE_TIMEOUT_MS = 1800

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/$/, '')
}

function getBaseUrl() {
  const app = getApp()
  return normalizeBaseUrl(app.globalData.apiBaseUrl)
}

function getBaseUrlCandidates() {
  // 只使用本地地址，避免局域网地址的502错误
  return [DEFAULT_LOCAL_API_BASE_URL].map(normalizeBaseUrl).filter(Boolean)
}

function setRuntimeBaseUrl(url) {
  const app = getApp()
  const normalized = normalizeBaseUrl(url)
  if (!normalized) return
  app.globalData.apiBaseUrl = normalized
}

function createApiError({ message, code = '', statusCode, payload, baseUrl, raw }) {
  const ex = new Error(`${message} (api=${baseUrl})`)
  ex.code = code
  ex.statusCode = statusCode
  ex.payload = payload
  ex.baseUrl = baseUrl
  ex.raw = raw
  return ex
}

function createAggregateNetworkError(baseUrls, failures) {
  const tried = baseUrls.join(', ')
  const detail = failures
    .map((item) => `${item.baseUrl}: ${item.message}`)
    .join(' | ')
  const ex = new Error(`all api endpoints failed: ${tried}`)
  ex.code = 'NETWORK_ERROR'
  ex.baseUrls = baseUrls
  ex.failures = failures
  ex.detail = detail
  return ex
}

function probeBaseUrl(baseUrl) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${baseUrl}/healthz`,
      method: 'GET',
      timeout: PROBE_TIMEOUT_MS,
      success: (res) => {
        const body = res.data || {}
        if (res.statusCode >= 200 && res.statusCode < 300 && body.ok !== false) {
          resolve(baseUrl)
          return
        }
        reject(
          createApiError({
            message: `probe failed: HTTP ${res.statusCode}`,
            statusCode: res.statusCode,
            payload: body,
            baseUrl,
          })
        )
      },
      fail: (err) => {
        reject(
          createApiError({
            message: (err && err.errMsg) || 'probe network error',
            code: 'NETWORK_ERROR',
            baseUrl,
            raw: err,
          })
        )
      },
    })
  })
}

function resolveReachableBaseUrl(baseUrls) {
  return new Promise((resolve, reject) => {
    const failures = []
    let settled = false

    baseUrls.forEach((baseUrl) => {
      probeBaseUrl(baseUrl)
        .then((okBaseUrl) => {
          if (settled) return
          settled = true
          setRuntimeBaseUrl(okBaseUrl)
          resolve(okBaseUrl)
        })
        .catch((err) => {
          failures.push({
            baseUrl,
            message: err.message || 'probe failed',
          })
          if (!settled && failures.length === baseUrls.length) {
            settled = true
            reject(createAggregateNetworkError(baseUrls, failures))
          }
        })
    })
  })
}

function request({ path, method = 'GET', data }) {
  const baseUrls = getBaseUrlCandidates()

  return new Promise((resolve, reject) => {
    const failures = []
    let settled = false
    const tasks = []

    const finishSuccess = (body, baseUrl, idx) => {
      if (settled) return
      settled = true
      if (idx > 0) {
        setRuntimeBaseUrl(baseUrl)
        console.warn('[api] fallback success, switched apiBaseUrl=%s', baseUrl)
      }
      tasks.forEach((task) => {
        if (task && typeof task.abort === 'function') {
          try {
            task.abort()
          } catch (e) {
            // ignore abort failures
          }
        }
      })
      resolve(body)
    }

    const finishFailureIfDone = () => {
      if (!settled && failures.length === baseUrls.length) {
        settled = true
        const nonNetwork = failures.find((item) => item.error.code !== 'NETWORK_ERROR')
        reject(nonNetwork ? nonNetwork.error : createAggregateNetworkError(baseUrls, failures))
      }
    }

    baseUrls.forEach((baseUrl, idx) => {
      const task = wx.request({
        url: `${baseUrl}${path}`,
        method,
        data,
        timeout: REQUEST_TIMEOUT_MS,
        success: (res) => {
          if (settled) return
          const body = res.data || {}
          if (res.statusCode >= 200 && res.statusCode < 300 && body.ok !== false) {
            finishSuccess(body, baseUrl, idx)
            return
          }

          const msg = (body.error && body.error.message) || `HTTP ${res.statusCode}`
        console.error('[api] request failed:', {
          baseUrl,
          path,
          method,
          data,
          statusCode: res.statusCode,
          error: body.error,
          fullResponse: body
        })
        failures.push({
          baseUrl,
          message: msg,
          error: createApiError({
            message: msg,
            code: (body.error && body.error.code) || '',
            statusCode: res.statusCode,
            payload: body,
            baseUrl,
          }),
        })
        finishFailureIfDone()
        },
        fail: (err) => {
          if (settled) return
          const errMsg = (err && err.errMsg) || 'network error'
          failures.push({
            baseUrl,
            message: errMsg,
            error: createApiError({
              message: errMsg,
              code: 'NETWORK_ERROR',
              baseUrl,
              raw: err,
            }),
          })
          finishFailureIfDone()
        },
      })
      tasks.push(task)
    })
  })
}

function uploadAvatar({ filePath, userOpenid }) {
  const baseUrls = getBaseUrlCandidates()

  return resolveReachableBaseUrl(baseUrls).then(
    (baseUrl) =>
      new Promise((resolve, reject) => {
        wx.uploadFile({
          url: `${baseUrl}/upload/avatar`,
          filePath,
          name: 'file',
          formData: {
            user_openid: userOpenid,
          },
          success: (res) => {
            let body = null
            try {
              body = JSON.parse(res.data || '{}')
            } catch (e) {
              reject(
                createApiError({
                  message: 'invalid upload response',
                  code: 'INVALID_RESPONSE',
                  statusCode: res.statusCode,
                  baseUrl,
                  raw: e,
                })
              )
              return
            }

            if (res.statusCode >= 200 && res.statusCode < 300 && body.ok !== false) {
              resolve(body)
              return
            }

            const msg = (body.error && body.error.message) || `HTTP ${res.statusCode}`
            reject(
              createApiError({
                message: msg,
                code: (body.error && body.error.code) || '',
                statusCode: res.statusCode,
                payload: body,
                baseUrl,
              })
            )
          },
          fail: (err) => {
            reject(
              createApiError({
                message: (err && err.errMsg) || 'network error',
                code: 'NETWORK_ERROR',
                baseUrl,
                raw: err,
              })
            )
          },
        })
      })
  )
}

function getLatestDevice(deviceId) {
  return request({
    path: `/device/latest?device_id=${encodeURIComponent(deviceId)}`,
  })
}

function setDeviceSound({ deviceId, soundEnabled }) {
  return request({
    path: '/device/sound',
    method: 'POST',
    data: {
      device_id: deviceId,
      sound_enabled: !!soundEnabled,
    },
  })
}

function getMonthlyLeaderboard(limit = 10) {
  return request({
    path: `/leaderboard/monthly?limit=${limit}`,
  })
}

function getUserProfile(userOpenid, monthKey = '') {
  const q = monthKey ? `&month_key=${encodeURIComponent(monthKey)}` : ''
  return request({
    path: `/user/profile?user_openid=${encodeURIComponent(userOpenid)}${q}`,
  })
}

function startMatch({ userOpenid, nickname, deviceId }) {
  return request({
    path: '/match/start',
    method: 'POST',
    data: {
      user_openid: userOpenid,
      nickname,
      device_id: deviceId,
    },
  })
}

function getActiveMatch({ deviceId, userOpenid }) {
  const query = []
  if (deviceId) query.push(`device_id=${encodeURIComponent(deviceId)}`)
  if (userOpenid) query.push(`user_openid=${encodeURIComponent(userOpenid)}`)
  const qs = query.join('&')
  return request({
    path: `/match/active?${qs}`,
  })
}

function stopMatch({ matchId, deviceId, userOpenid, endReason = 'MANUAL_STOP' }) {
  return request({
    path: '/match/stop',
    method: 'POST',
    data: {
      match_id: matchId || '',
      device_id: deviceId || '',
      user_openid: userOpenid || '',
      end_reason: endReason,
    },
  })
}

function getMatchRealtime(matchId) {
  return request({
    path: `/match/realtime?match_id=${encodeURIComponent(matchId)}`,
  })
}

function getMatchSamples(matchId, limit = 60) {
  return request({
    path: `/match/samples?match_id=${encodeURIComponent(matchId)}&limit=${limit}`,
  })
}

function wxLogin(code) {
  // 注意：当前实现中不再使用这个函数
  // 因为openid已经在app.js的_applyRuntimeConfig中持久化了
  // 如果需要真实的微信登录验证，可以在这里实现
  return request({
    path: '/auth/wx-login',
    method: 'POST',
    data: { code },
  })
}

function updateUserProfile({ userOpenid, nickname, avatarUrl }) {
  return request({
    path: '/user/update',
    method: 'POST',
    data: {
      user_openid: userOpenid,
      nickname,
      avatar_url: avatarUrl,
    },
  })
}

module.exports = {
  getLatestDevice,
  setDeviceSound,
  getMonthlyLeaderboard,
  getUserProfile,
  startMatch,
  getActiveMatch,
  stopMatch,
  getMatchRealtime,
  getMatchSamples,
  wxLogin,
  updateUserProfile,
  uploadAvatar,
}
