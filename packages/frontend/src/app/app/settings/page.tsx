'use client'

export default function SettingsPage() {
  return (
    <div>
      <div className="row hairline-b" style={{ padding: '14px 24px' }}>
        <div className="micro">SETTINGS</div>
      </div>
      <div style={{ padding: 24 }}>
        <div className="panel" style={{ padding: 32, textAlign: 'center', maxWidth: 480, margin: '60px auto' }}>
          <div className="micro" style={{ color: 'var(--cyan)' }}>COMING SOON</div>
          <h3 className="h3 mt-3" style={{ margin: 0 }}>Settings</h3>
          <p className="body mt-3" style={{ color: 'var(--text-2)' }}>Note encryption preferences, relay configuration, decoy traffic settings, and privacy controls will appear here.</p>
        </div>
      </div>
    </div>
  )
}
