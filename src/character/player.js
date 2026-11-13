function bootCharacterPlayer() {
  'use strict'
  const card = JSON.parse(document.getElementById('character-data').textContent)
  const $ = id => document.getElementById(id)
  const list = $('messages'), form = $('chat-form'), input = $('chat-input'), send = $('send'), stop = $('stop')
  const notice = $('notice'), detail = $('world-status'), preset = $('preset'), postPreset = $('post-preset'), greeting = $('greeting'), reset = $('reset'), profile = $('profile')
  const key = card.saveKey
  const limits = { historyBytes: 240 * 1024, historyTurns: 2000, recentChars: 32000, recentTurns: 24, requestChars: 60000, requestTurns: 40, timeoutMs: 120000 }
  let messages = [], active = null, busy = false, saving = Promise.resolve(), contentDraft = null, storageBlocked = false
  const clone = value => JSON.parse(JSON.stringify(value))
  const fill = text => String(text || '').replace(/\{\{\s*char\s*\}\}/gi, () => card.name).replace(/\{\{\s*user\s*\}\}/gi, '玩家')
  const say = text => { notice.textContent = text }
  const historyFits = turns => turns.length <= limits.historyTurns && new TextEncoder().encode(JSON.stringify(turns)).length <= limits.historyBytes
  const opening = () => {
    const content = fill(card.greetings[Number(greeting.value)] || '')
    return content ? [{ role: 'assistant', content }] : []
  }
  const ensureOpening = () => { if (!messages.length) messages = opening() }
  const persist = () => {
    if (storageBlocked) { say('旧存档未能安全加载；为避免覆盖，禁止写入，请先导出/适配存档或明确开始新故事。'); return Promise.resolve(false) }
    const state = clone({ version: 1, messages, preset: preset.value, postPreset: postPreset.value, greeting: greeting.value })
    if (!historyFits(state.messages) || new TextEncoder().encode(JSON.stringify(state)).length > 256 * 1024) { say('完整历史/预设已达本地存档预算；未删除历史，请导出存档后开始新故事。'); return Promise.resolve(false) }
    saving = saving.then(async () => { await window.Workbench.storage.set(key, state); return true }).catch(() => { say('暂时无法保存。完整对话仍在本页，请在关闭前导出存档。'); return false })
    return saving
  }
  const row = (role, content) => {
    const article = document.createElement('article'); article.className = role === 'user' ? 'turn user' : 'turn assistant'
    const name = document.createElement('strong'); name.textContent = role === 'user' ? '你' : card.name
    const text = document.createElement('div'); text.textContent = content
    article.append(name, text); list.append(article); return text
  }
  const scroll = () => { list.scrollTop = list.scrollHeight }
  const render = () => { list.replaceChildren(); for (const turn of messages) row(turn.role, turn.content); if (!messages.length) row('assistant', '故事从你的第一句话开始。'); greeting.disabled = busy || messages.some(m => m.role === 'user'); scroll() }
  const setBusy = value => {
    busy = value; input.disabled = value; send.disabled = value; stop.hidden = !value
    greeting.disabled = value || messages.some(m => m.role === 'user'); preset.disabled = value; postPreset.disabled = value; reset.disabled = value
    $('apply-card').disabled = value
    // Profile selection may change during a request; the dispatched profile is already frozen.
  }
  const entriesText = entries => entries.map(e => `## ${e.name}\n${fill(e.content)}`).join('\n\n')
  const selectWorld = history => {
    const scan = history.slice(-6).map(m => m.content).join('\n').toLowerCase()
    const hits = card.worldEntries.filter(e => e.enabled && e.content && (e.constant || e.keys.some(word => word && scan.includes(word.toLowerCase()))))
      .sort((a, b) => Number(b.constant) - Number(a.constant) || a.order - b.order)
    const picked = []; let chars = 0
    for (const entry of hits) if (picked.length < 12 && chars + entry.content.length <= 12000) { picked.push(entry); chars += entry.content.length }
    return { picked, skipped: hits.length - picked.length }
  }
  const examples = () => {
    const text = fill(card.mesExample), result = []; let current = null, invalid = false
    for (const line of text.split('\n')) {
      if (/^\s*<START>\s*$/i.test(line) || !line.trim()) { if (current && !line.trim()) current.content += '\n'; continue }
      const prefix = /^\s*([^:：]+)[:：]\s*(.*)$/.exec(line)
      const role = prefix && (prefix[1] === '玩家' || /^user$/i.test(prefix[1]) ? 'user' : prefix[1] === card.name || /^(assistant|char)$/i.test(prefix[1]) ? 'assistant' : '')
      if (role) { current = { role, content: prefix[2] }; result.push(current) }
      else if (current) current.content += '\n' + line
      else invalid = true
    }
    return text && (!result.length || invalid) ? { messages: [], fallback: text } : { messages: result, fallback: '' }
  }
  const buildRequest = history => {
    const selected = selectWorld(history), picked = selected.picked
    const at = position => entriesText(picked.filter(e => e.position === position))
    const systemBase = fill(preset.value)
    const systemInstruction = card.systemPrompt ? fill(card.systemPrompt).replace(/\{\{\s*original\s*\}\}/gi, () => systemBase) : systemBase
    const example = examples()
    const parts = [systemInstruction, at('before_char'), card.description && '# Character\n' + fill(card.description), card.personality && '# Personality\n' + fill(card.personality), card.scenario && '# Scenario\n' + fill(card.scenario), at('after_char'), at('before_example'), example.fallback && '# Example dialogue\n' + example.fallback]
    const request = [{ role: 'system', content: parts.filter(Boolean).join('\n\n') }, ...example.messages]
    if (at('after_example')) request.push({ role: 'system', content: at('after_example') })
    let recent = [], chars = 0
    for (let i = history.length - 1; i >= 0 && recent.length < limits.recentTurns; i--) {
      const m = history[i]
      if (chars + m.content.length > limits.recentChars) {
        if (!recent.length) throw new Error('当前消息超过近期上下文预算，未截断内容；请缩短输入或调整组件预算')
        break
      }
      recent.unshift({ role: m.role, content: m.content }); chars += m.content.length
    }
    const omitted = history.length - recent.length
    const start = request.length
    request.push(...recent)
    const injections = picked.filter(e => e.position === 'at_depth').map((e, i) => ({ e, i, at: Math.max(start, request.length - Math.max(0, Math.floor(e.depth ?? 4))) })).sort((a, b) => a.at - b.at || a.i - b.i)
    injections.forEach((item, i) => request.splice(item.at + i, 0, { role: item.e.role || 'system', content: fill(item.e.content) }))
    const post = card.postHistoryInstructions ? fill(card.postHistoryInstructions).replace(/\{\{\s*original\s*\}\}/gi, () => fill(postPreset.value)) : fill(postPreset.value)
    if (post) request.push({ role: 'system', content: post })
    if (request.length > limits.requestTurns || request.reduce((n, m) => n + m.content.length, 0) > limits.requestChars) throw new Error('完整角色/示例/世界书与近期对话超过桥接预算（40条/60000字符）；未截断设定，请调整内容或组件预算')
    return { messages: request, picked, skipped: selected.skipped, omitted }
  }
  const populateGreetings = () => {
    greeting.replaceChildren()
    card.greetings.forEach((text, i) => { const option = document.createElement('option'); option.value = String(i); option.textContent = i === 0 ? '主开场白' : `备用开场白 ${i}`; greeting.append(option) })
  }
  const fields = { name: 'name', description: 'description', personality: 'personality', scenario: 'scenario', firstMes: 'first_mes', mesExample: 'mes_example', creatorNotes: 'creator_notes', systemPrompt: 'system_prompt', postHistoryInstructions: 'post_history_instructions' }
  const aliases = { first_mes: 'firstMessage', mes_example: 'mesExample', creator_notes: 'creatorNotes', system_prompt: 'systemPrompt', post_history_instructions: 'postHistoryInstructions' }
  const editor = () => {
    $('card-fields').replaceChildren()
    for (const field of Object.keys(fields)) {
      const label = document.createElement('label'); label.htmlFor = `field-${field}`; label.textContent = fields[field]
      const area = document.createElement('textarea'); area.id = `field-${field}`; area.rows = field === 'name' ? 1 : 3; area.value = card[field] || ''
      $('card-fields').append(label, area)
    }
  }
  const download = (text, name) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })), a = document.createElement('a')
    a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url)
  }
  const encodeJson = target => {
    const raw = clone(contentDraft || card.raw)
    if (target === 'v2') {
      if (raw.spec === 'chara_card_v3') throw new Error('V3 降版到 V2 尚未验证；请导出当前 V3 JSON')
      const data = raw.data && typeof raw.data === 'object' ? raw.data : raw
      const rawFields = { ...fields, creator: 'creator', version: 'character_version' }
      for (const [field, key] of Object.entries(rawFields)) data[key] = typeof data[key] === 'string' ? data[key] : typeof data[aliases[key]] === 'string' ? data[aliases[key]] : card[field] || ''
      Object.assign(data, { alternate_greetings: card.alternateGreetings, tags: card.tags, creator: card.creator, character_version: card.version, extensions: data.extensions || {} })
      if (data.characterBook && !data.character_book) data.character_book = data.characterBook
      if (data.character_book) {
        data.character_book.extensions = data.character_book.extensions || {}
        data.character_book.entries = data.character_book.entries.map((e, i) => {
          if (e.position != null && ![0, 1, 'before_char', 'after_char'].includes(e.position)) throw new Error('世界书位置不能无损转为 V2 标准；请导出当前 JSON')
          const mapped = { ...e, keys: Array.isArray(e.keys) ? e.keys : String(e.keys || '').split(/[,，、]/).filter(Boolean), enabled: e.enabled !== false && e.disable !== true, insertion_order: typeof e.insertion_order === 'number' && Number.isFinite(e.insertion_order) ? e.insertion_order : typeof e.order === 'number' && Number.isFinite(e.order) ? e.order : i, extensions: e.extensions && typeof e.extensions === 'object' && !Array.isArray(e.extensions) ? e.extensions : {}, case_sensitive: e.case_sensitive === true }
          if (e.position === 0) mapped.position = 'before_char'
          if (e.position === 1) mapped.position = 'after_char'
          return mapped
        })
      }
      return JSON.stringify({ ...(raw.data ? raw : {}), spec: 'chara_card_v2', spec_version: '2.0', data }, null, 2) + '\n'
    }
    return JSON.stringify(raw, null, 2) + '\n'
  }
  $('apply-card').onclick = () => {
    if (busy) return
    const draft = clone(contentDraft || card.raw), data = draft.data && typeof draft.data === 'object' ? draft.data : draft
    for (const [field, key] of Object.entries(fields)) {
      const value = $(`field-${field}`).value, alias = aliases[key]
      data[!(key in data) && alias && alias in data ? alias : key] = value
      if (key in data && alias && alias in data) data[alias] = value
    }
    contentDraft = draft
    $('edit-status').textContent = '未提交草稿：本阶段作品没有写工作空间权限。可导出草稿 JSON，或回到工作台让 UI/Agent 通过 source + manifest 重组提交；播放器仍使用已提交版本。'
  }
  const exportCard = target => {
    try { download(encodeJson(target), `${card.name.replace(/[\\/:*?"<>|]/g, '_')}${contentDraft ? '-unsubmitted-draft' : ''}${target === 'v2' ? '-v2' : '-current'}.json`); $('edit-status').textContent = `${contentDraft ? '导出未提交草稿' : '导出本页绑定的已提交内容 revision'}；${target === 'v2' ? '指定 V2 JSON，不是原格式写回。' : card.identity && card.spec && card.raw ? 'JSON 载体；PNG 图片写回未实现。' : '当前 JSON 结构保留。'}未知字段/原扩展保留，不附组件层或聊天。` }
    catch (error) { $('edit-status').textContent = String(error.message || error) }
  }
  $('export-card').onclick = () => exportCard('original'); $('export-v2').onclick = () => exportCard('v2')
  populateGreetings(); editor()
  $('character-name').textContent = card.name; document.title = card.name + ' · 角色试玩'
  $('card-details').textContent = [card.spec, ...card.warnings].join('\n\n')
  preset.value = '你在互动故事中扮演指定角色。延续情节，尊重玩家的选择，不替玩家决定行动。'
  postPreset.value = ''
  greeting.onchange = () => { if (messages.some(m => m.role === 'user')) return; messages = opening(); render(); void persist() }
  preset.onchange = () => void persist(); postPreset.onchange = () => void persist()
  reset.onclick = () => { if (busy || !window.confirm('开始新故事会清空当前故事；需要的话请先导出存档。继续吗？')) return; storageBlocked = false; messages = opening(); render(); void persist(); say('已开始新故事。') }
  stop.onclick = () => { if (active) active.cancel('已停止回复') }
  form.onsubmit = async event => {
    event.preventDefault()
    const text = input.value.trim()
    if (busy || !text) return
    if (storageBlocked) { say('存档未能安全加载，暂不发送/写入；请先导出旧存档或明确开始新故事。'); return }
    if (!window.Workbench?.ai) { say('请在工作台授权 AI，或在导出作品的 AI 设置里配置模型。'); return }
    ensureOpening()
    const candidate = [...messages, { role: 'user', content: text }]
    if (!historyFits(candidate)) { say('完整本地历史已达预算；本次未发送/未写入，请导出存档后开始新故事。'); return }
    let built
    try { built = buildRequest(candidate) } catch (error) { say(error.message || String(error)); return }
    detail.textContent = `本轮世界书：${built.picked.map(e => e.name).join('、') || '无命中'}；预算跳过 ${built.skipped} 条；近期上下文省略 ${built.omitted} 条旧消息（本地完整历史保留）。`
    const profileId = profile.value || undefined
    row('user', text); const output = row('assistant', '正在回应…'); scroll(); setBusy(true)
    say(`正在请求玩法模型${profileId ? ' ' + profileId : '（作品默认）'}；将发送角色、示例、命中世界书与近期对话。`)
    let response = '', transport = null, cancelled = false, rejectCancel
    const cancellation = new Promise((resolve, reject) => { rejectCancel = reject })
    active = { cancel: reason => { if (cancelled) return; cancelled = true; if (transport && typeof transport.cancel === 'function') transport.cancel(); rejectCancel(new Error(reason)) } }
    const timer = setTimeout(() => { if (active) active.cancel('回复超时，已取消请求') }, limits.timeoutMs)
    try {
      transport = window.Workbench.ai.chat({ profileId, messages: clone(built.messages), onChunk: chunk => { if (cancelled) return; response += String(chunk); output.textContent = response; scroll() } })
      const result = await Promise.race([transport, cancellation])
      if (cancelled) throw new Error('回复已取消')
      response = result && typeof result.text === 'string' ? result.text : response
      if (!response.trim()) throw new Error('模型没有返回正文，请重试')
      const complete = [...candidate, { role: 'assistant', content: response }]
      if (!historyFits(complete)) throw new Error('回复超过完整本地历史预算；未写入/未删除旧历史，请导出存档后重试')
      messages = complete; input.value = ''
      if (await persist()) say('已保存完整当前故事。')
    } catch (error) { say(`本次未写入对话记录：${String(error && error.message || error)}。输入仍保留，可重试。`) }
    finally { clearTimeout(timer); active = null; setBusy(false); render(); input.focus() }
  }
  input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit() } }
  // A small supported API for tests/custom components. It cannot grant file or model authorization.
  window.CharacterArtifact = { buildRequest, encodeJson, getContent: () => clone(card.raw), getDraft: () => contentDraft && clone(contentDraft), limits }
  const ready = async () => {
    setBusy(true)
    try {
      const saved = await window.Workbench?.storage?.get(key)
      if (saved && Array.isArray(saved.messages)) {
        if (saved.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) throw new Error('存档结构无效，未加载')
        if (!historyFits(saved.messages)) throw new Error('存档超过基础包历史预算；未截断/未覆盖，请导出后适配')
        messages = saved.messages.map(m => ({ role: m.role, content: m.content }))
        if (typeof saved.preset === 'string') preset.value = saved.preset
        if (typeof saved.postPreset === 'string') postPreset.value = saved.postPreset
        if (card.greetings[Number(saved.greeting)]) greeting.value = String(Number(saved.greeting))
      }
    } catch (error) { storageBlocked = true; say('存档未加载：' + String(error.message || error)) }
    try {
      if (typeof window.Workbench?.ai?.getProfiles === 'function') {
        const result = await window.Workbench.ai.getProfiles(), profiles = Array.isArray(result) ? result : result && result.profiles || []
        for (const p of profiles) { if (!p.profileId) continue; const option = document.createElement('option'); option.value = p.profileId; option.textContent = `${p.name || p.profileId} · ${p.model || ''} · ${p.baseUrl || ''}`; profile.append(option) }
      }
    } catch (error) { say('玩法模型列表暂不可用：' + String(error.message || error)) }
    ensureOpening(); setBusy(false); render()
  }
  void ready()
}
bootCharacterPlayer()
