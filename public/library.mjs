const $ = id => document.getElementById(id)
let offset = 0, loading = false, revision = 0, controller, projects = [], refreshTimer
const mobile = matchMedia("(max-width: 760px)")
let collapsed = false, drawerOpen = false
try { collapsed = localStorage.getItem("projects-sidebar-collapsed") === "true" } catch {}

export function setupAccount(session) {
  $('release-status').hidden = session.mode !== 'password'
  document.body.classList.toggle('has-sidebar', !!session.user)
  $('library').hidden = !session.user
  $('toggle-sidebar').hidden = !session.user
  if (session.user) {
    syncSidebar()
    $('toggle-sidebar').onclick = () => {
      if (mobile.matches) drawerOpen = !drawerOpen
      else {
        collapsed = !collapsed
        try { localStorage.setItem('projects-sidebar-collapsed', String(collapsed)) } catch {}
      }
      syncSidebar()
      if (mobile.matches && drawerOpen) $('close-sidebar').focus()
    }
    $('close-sidebar').onclick = () => closeSidebar()
    $('sidebar-scrim').onclick = () => closeSidebar()
    mobile.addEventListener('change', () => { drawerOpen = false; syncSidebar() })
    $('library').addEventListener('click', event => {
      if (event.target.closest('a') && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0 && mobile.matches) closeSidebar()
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && (drawerOpen || (!mobile.matches && !collapsed && $('library').contains(document.activeElement)))) closeSidebar()
      if (event.key !== 'Tab' || !mobile.matches || !drawerOpen) return
      const focusable = [...$('library').querySelectorAll('a[href], button:not(:disabled)')].filter(el => el.getClientRects().length)
      const first = focusable[0], last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    })
    loadFilms()
  }
  $('account-name').textContent = session.user?.username || ''
  $('sign-out').hidden = !session.user || session.mode === 'local'
  $('sign-out').onclick = async () => {
    try {
      const response = await fetch('/api/logout', { method: 'POST' })
      if (!response.ok) throw Error()
      location.assign('/')
    } catch { $('account-name').textContent = 'Could not sign out. Try again.' }
  }
  $('login-form').onsubmit = async event => {
    event.preventDefault()
    $('login-submit').disabled = true
    $('login-status').textContent = 'Signing in…'
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('login-username').value, password: $('login-password').value }) })
      const answer = await response.json()
      if (!response.ok) throw Error(answer.error || 'Could not sign in.')
      location.reload()
    } catch (error) { $('login-status').textContent = error.message || 'Could not reach the server.' }
    finally { $('login-password').value = ''; $('login-submit').disabled = false }
  }
  $('more-films').onclick = () => loadFilms(true)
}

export async function loadFilms(append = false) {
  if (append && loading) return
  controller?.abort()
  controller = new AbortController()
  const current = ++revision
  loading = true
  $('more-films').disabled = true
  $('films-status').textContent = 'Loading your projects…'
  if (!append) offset = 0
  try {
    const response = await fetch(`/api/films?offset=${offset}`, { signal: controller.signal })
    if (response.status === 401) { location.reload(); return }
    if (!response.ok) throw Error('Could not load your projects. Reload to try again.')
    const result = await response.json()
    if (current !== revision) return
    if (!append) $('saved-films').replaceChildren()
    projects = append ? [...projects, ...result.films] : result.films
    renderProjects()
    offset += result.films.length
    $('more-films').hidden = !result.more
    $('films-status').textContent = offset ? '' : 'Your projects will appear here after you make your first manual.'
  } catch (error) {
    if (error.name !== 'AbortError' && current === revision) $('films-status').textContent = error.message
  } finally {
    if (current === revision) {
      loading = false; $('more-films').disabled = false
    }
  }
}

function syncSidebar() {
  const open = mobile.matches ? drawerOpen : !collapsed
  document.body.classList.toggle('sidebar-collapsed', collapsed)
  document.body.classList.toggle('sidebar-open', mobile.matches && drawerOpen)
  $('toggle-sidebar').hidden = open
  $('toggle-sidebar').setAttribute('aria-expanded', String(open))
  $('toggle-sidebar').setAttribute('aria-label', open ? 'Close sidebar' : 'Open sidebar')
  $('library').inert = !open
  $('app-content').inert = mobile.matches && drawerOpen
  $('sidebar-scrim').hidden = !mobile.matches || !drawerOpen
  if (mobile.matches && drawerOpen) {
    $('library').setAttribute('role', 'dialog')
    $('library').setAttribute('aria-modal', 'true')
  } else {
    $('library').removeAttribute('role')
    $('library').removeAttribute('aria-modal')
  }
}
function closeSidebar() {
  if (mobile.matches) drawerOpen = false
  else {
    collapsed = true
    try { localStorage.setItem('projects-sidebar-collapsed', 'true') } catch {}
  }
  syncSidebar()
  $('toggle-sidebar').focus()
}
export function selectProject() {
  for (const link of $('saved-films').querySelectorAll('a')) {
    if (link.pathname === location.pathname) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
}
export function refreshProjects() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => loadFilms(), 200)
}
export function updateProject(id, changes) {
  const project = projects.find(project => project.id === id)
  if (!project || Object.entries(changes).every(([key, value]) => project[key] === value)) return
  Object.assign(project, changes)
  renderProjects()
}
function renderProjects() {
  $('saved-films').replaceChildren()
  let lastGroup
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const week = new Date(today); week.setDate(week.getDate() - 7)
  for (const film of projects) {
    const date = new Date(film.createdAt)
    const group = date >= today ? 'Today' : date >= yesterday ? 'Yesterday' : date >= week ? 'Previous 7 days' : 'Older projects'
    if (group !== lastGroup) {
      const heading = document.createElement('li')
      heading.className = 'history-date'; heading.textContent = group
      $('saved-films').append(heading); lastGroup = group
    }
    const li = document.createElement('li'), link = document.createElement('a'), title = document.createElement('span')
    link.href = `/films/${film.id}`; link.dataset.page = ''
    title.className = 'project-title'; title.textContent = film.title
    const labels = { running: 'Generating', completed: 'Ready to watch', failed: 'Generation failed', interrupted: 'Generation interrupted' }
    const details = `${labels[film.status] || film.status} · ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}${film.previous ? ' · Revised' : ''}`
    link.title = `${film.title} — ${details}`
    if (film.status !== 'completed') {
      const dot = document.createElement('span')
      dot.className = `project-state ${film.status}`; dot.setAttribute('aria-hidden', 'true'); link.append(dot)
    }
    const description = document.createElement('span')
    description.className = 'sr-only'; description.textContent = `, ${details}`
    link.append(title, description); li.append(link); $('saved-films').append(li)
  }
  selectProject()
}
