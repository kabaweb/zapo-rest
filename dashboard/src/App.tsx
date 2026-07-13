import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { clearStoredKey, getStoredKey, type Instance, me, setInstanceHint, setStoredKey } from './api/client'
import { Softphone } from './components/Softphone'
import { InstanceHomePage } from './pages/InstanceHome'
import { InstancesPage } from './pages/Instances'
import { LoginPage } from './pages/Login'
import { ApiExplorerPage } from './pages/tools/ApiExplorer'
import { CallsPage } from './pages/tools/Calls'
import { ConnectionPage } from './pages/tools/Connection'
import { ContactsPage } from './pages/tools/Contacts'
import { EventsPage } from './pages/tools/Events'
import { FullChatPage } from './pages/tools/FullChat'
import { GroupsPage } from './pages/tools/Groups'
import { LabelsPage } from './pages/tools/Labels'
import { LidsPage } from './pages/tools/Lids'
import { LiveChatPage } from './pages/tools/LiveChat'
import { MediaPage } from './pages/tools/Media'
import { MetricsPage } from './pages/tools/Metrics'
import { PresencePage } from './pages/tools/Presence'
import { PrivacyPage } from './pages/tools/Privacy'
import { ProfilePage } from './pages/tools/Profile'
import { SendTesterPage } from './pages/tools/SendTester'
import { StatusStoriesPage } from './pages/tools/StatusStories'
import { UserLookupPage } from './pages/tools/UserLookup'
import { WebhooksPage } from './pages/tools/Webhooks'

type Session = { role: 'admin' } | { role: 'instance'; instance: Instance } | null

export function App() {
  const [session, setSession] = useState<Session>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    void (async () => {
      const key = getStoredKey()
      if (!key) {
        setLoading(false)
        return
      }
      try {
        const data = await me()
        if (data.role === 'instance') setInstanceHint(data.instance.name)
        setSession(data)
      } catch {
        clearStoredKey()
        setSession(null)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function handleLogin(apiKey: string) {
    setStoredKey(apiKey)
    const data = await me()
    if (data.role === 'instance') {
      setInstanceHint(data.instance.name)
      setSession(data)
      navigate(`/instances/${data.instance.name}`)
    } else {
      setSession(data)
      navigate('/instances')
    }
  }

  function logout() {
    clearStoredKey()
    setSession(null)
    navigate('/login')
  }

  if (loading) {
    return (
      <div className="login-screen">
        <p className="muted">Carregando…</p>
      </div>
    )
  }

  const authed = Boolean(session)
  const guard = (node: React.ReactNode) => (authed ? node : <Navigate to="/login" replace />)

  return (
    <>
      <Routes>
        <Route
          path="/login"
          element={
            session ? (
              <Navigate to={session.role === 'admin' ? '/instances' : `/instances/${session.instance.name}`} replace />
            ) : (
              <LoginPage onLogin={handleLogin} />
            )
          }
        />
        <Route
          path="/instances"
          element={guard(
            session?.role === 'admin' ? (
              <InstancesPage onLogout={logout} />
            ) : session?.role === 'instance' ? (
              <Navigate to={`/instances/${session.instance.name}`} replace />
            ) : (
              <Navigate to="/login" replace />
            ),
          )}
        />
        <Route path="/instances/:name" element={guard(<InstanceHomePage onLogout={logout} />)} />
        <Route path="/instances/:name/connection" element={guard(<ConnectionPage onLogout={logout} />)} />
        <Route path="/instances/:name/chat" element={guard(<FullChatPage onLogout={logout} />)} />
        <Route path="/instances/:name/live-chat" element={guard(<LiveChatPage onLogout={logout} />)} />
        <Route path="/instances/:name/send" element={guard(<SendTesterPage onLogout={logout} />)} />
        <Route path="/instances/:name/webhooks" element={guard(<WebhooksPage onLogout={logout} />)} />
        <Route path="/instances/:name/groups" element={guard(<GroupsPage onLogout={logout} />)} />
        <Route path="/instances/:name/contacts" element={guard(<ContactsPage onLogout={logout} />)} />
        <Route path="/instances/:name/lookup" element={guard(<UserLookupPage onLogout={logout} />)} />
        <Route path="/instances/:name/events" element={guard(<EventsPage onLogout={logout} />)} />
        <Route path="/instances/:name/profile" element={guard(<ProfilePage onLogout={logout} />)} />
        <Route path="/instances/:name/labels" element={guard(<LabelsPage onLogout={logout} />)} />
        <Route path="/instances/:name/privacy" element={guard(<PrivacyPage onLogout={logout} />)} />
        <Route path="/instances/:name/status" element={guard(<StatusStoriesPage onLogout={logout} />)} />
        <Route path="/instances/:name/media" element={guard(<MediaPage onLogout={logout} />)} />
        <Route path="/instances/:name/metrics" element={guard(<MetricsPage onLogout={logout} />)} />
        <Route path="/instances/:name/lids" element={guard(<LidsPage onLogout={logout} />)} />
        <Route path="/instances/:name/presence" element={guard(<PresencePage onLogout={logout} />)} />
        <Route path="/instances/:name/calls" element={guard(<CallsPage onLogout={logout} />)} />
        <Route path="/instances/:name/api" element={guard(<ApiExplorerPage onLogout={logout} />)} />
        <Route path="*" element={<Navigate to={session ? '/instances' : '/login'} replace />} />
      </Routes>
      {/* Floating softphone (wavoip-style) on instance routes when authenticated */}
      {authed && <Softphone />}
    </>
  )
}
