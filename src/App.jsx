import { useState, useEffect, useCallback } from 'react'

// ─────────────────────────────────────────────
// CONFIG — set your values here or in .env
// ─────────────────────────────────────────────
const AIRTABLE_PAT     = import.meta.env.VITE_AIRTABLE_PAT || ''
const AIRTABLE_BASE_ID = import.meta.env.VITE_AIRTABLE_BASE_ID || 'appKtPJiD3Pex9ai1'
const AIRTABLE_TABLE_ID = import.meta.env.VITE_AIRTABLE_TABLE_ID || 'tblfEZNHgfRwvvVJc'

// ─────────────────────────────────────────────
// AIRTABLE — maps your exact field names
// ─────────────────────────────────────────────
function mapRecord(record) {
  const f = record.fields
  return {
    id:               record.id,
    name:             f['Activity Name']          || '',
    type:             f['Type of Activity']        || '',
    location:         f['Location']               || '',
    address:          f['Address']                || '',
    zip:              String(f['Activity Zip Code'] || ''),
    format:           f['Virtual/In-Person/Hybrid'] || 'In-Person',
    schedule:         f['Days/Times Meeting']     || '',
    daysOfWeek:       f['Days of Week']           || '',
    timeOfDay:        f['Time of Day']            || '',
    intensity:        f['Level of Intensity']     || '',
    costDisplay:      f['Cost Display']           || f['Cost']  || '',
    costCategory:     f['Cost Category']          || '',
    contact:          f['Program Contact']        || '',
    email:            f['Program Email Address']  || '',
    phone:            f['Site Phone #']           || f['Phone Info'] || '',
    registrationLink: f['Online Registration Link'] || '',
    website:          f['Online Website']         || f['Info'] || '',
    caregiverFriendly:f['Caregiver Friendly']     || '',
    status:           f['Status']                 || 'Active',
    lat:              f['Latitude']               || null,
    lng:              f['Longitude']              || null,
  }
}

async function fetchActivities(filters = {}) {
  const conditions = [`{Status} = 'Active'`]

  if (filters.q) {
    const q = filters.q.replace(/'/g, "\\'")
    conditions.push(`OR(SEARCH('${q}',{Activity Name}),SEARCH('${q}',{Type of Activity}),SEARCH('${q}',{Location}))`)
  }
  if (filters.type)      conditions.push(`{Type of Activity} = '${filters.type}'`)
  if (filters.intensity) conditions.push(`SEARCH('${filters.intensity}',{Level of Intensity})`)
  if (filters.cost)      conditions.push(`{Cost Category} = '${filters.cost}'`)
  if (filters.format)    conditions.push(`{Virtual/In-Person/Hybrid} = '${filters.format}'`)
  if (filters.timeOfDay) conditions.push(`SEARCH('${filters.timeOfDay}',{Time of Day})`)

  const formula = conditions.length > 1 ? `AND(${conditions.join(',')})` : conditions[0]
  const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`)
  url.searchParams.set('filterByFormula', formula)
  url.searchParams.set('pageSize', '100')

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` }
  })
  if (!res.ok) throw new Error(`Airtable error: ${res.status}`)
  const data = await res.json()

  let activities = data.records.map(mapRecord)

  // Sort by proximity if zip provided and records have lat/lng
  if (filters.zip && /^\d{5}$/.test(filters.zip)) {
    const zipCoords = ZIP_COORDS[filters.zip]
    if (zipCoords) {
      activities = activities
        .map(a => ({
          ...a,
          dist: a.lat && a.lng
            ? haversine(zipCoords[0], zipCoords[1], a.lat, a.lng)
            : 9999
        }))
        .sort((a, b) => a.dist - b.dist)
    }
  }

  return activities
}

async function fetchActivityById(id) {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}/${id}`,
    { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` } }
  )
  if (!res.ok) throw new Error('Activity not found')
  return mapRecord(await res.json())
}

// Distance in miles between two lat/lng points
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

// Minnesota zip code coordinates (add more as needed)
const ZIP_COORDS = {
  '55401': [44.9778, -93.2650], '55402': [44.9741, -93.2713], '55403': [44.9703, -93.2879],
  '55404': [44.9612, -93.2686], '55405': [44.9703, -93.3031], '55406': [44.9375, -93.2284],
  '55407': [44.9339, -93.2534], '55408': [44.9475, -93.2998], '55409': [44.9260, -93.2965],
  '55410': [44.9117, -93.3210], '55411': [44.9936, -93.3100], '55412': [45.0108, -93.3005],
  '55413': [44.9958, -93.2534], '55414': [44.9806, -93.2284], '55415': [44.9741, -93.2654],
  '55416': [44.9597, -93.3427], '55417': [44.9117, -93.2534], '55418': [45.0108, -93.2284],
  '55419': [44.9006, -93.2998], '55420': [44.8648, -93.3031], '55421': [45.0478, -93.2654],
  '55422': [45.0108, -93.3427], '55423': [44.8934, -93.3210], '55424': [44.9006, -93.3427],
  '55425': [44.8648, -93.2284], '55426': [44.9339, -93.3769], '55427': [44.9855, -93.3710],
  '55428': [45.0478, -93.3769], '55429': [45.0478, -93.3427], '55430': [45.0647, -93.3100],
  '55431': [44.8358, -93.3499], '55432': [45.0988, -93.2534], '55433': [45.1168, -93.3100],
  '55434': [45.1508, -93.3100], '55435': [44.8934, -93.3427], '55436': [44.8934, -93.3769],
  '55437': [44.8287, -93.3210], '55438': [44.8108, -93.3210], '55439': [44.8648, -93.3427],
  '55441': [45.0108, -93.4109], '55442': [45.0478, -93.4109], '55443': [45.0817, -93.3769],
  '55444': [45.1168, -93.3769], '55445': [45.1168, -93.4109], '55446': [45.0478, -93.4769],
  '55447': [45.0108, -93.4769], '55448': [45.1508, -93.3769], '55449': [45.1678, -93.3100],
  '55001': [45.0270, -92.8893], '55008': [45.5727, -93.2244], '55011': [45.3670, -93.2244],
  '55014': [45.1508, -93.1534], '55016': [44.8648, -92.9534], '55025': [45.1928, -92.9534],
  '55033': [44.7287, -92.9534], '55038': [45.0817, -92.9534], '55042': [44.9478, -92.8534],
  '55044': [44.6587, -93.2534], '55055': [44.8648, -92.9934], '55068': [44.7547, -93.1534],
  '55075': [44.8648, -93.0534], '55082': [45.0478, -92.8534], '55109': [45.0108, -93.0834],
  '55110': [45.0647, -93.0534], '55112': [45.0647, -93.1834], '55113': [45.0108, -93.1534],
  '55114': [44.9597, -93.1834], '55115': [45.0268, -92.9234], '55116': [44.9117, -93.1534],
  '55117': [44.9936, -93.1100], '55118': [44.9117, -93.0834], '55119': [44.9339, -93.0534],
  '55120': [44.8724, -93.0834], '55121': [44.8724, -93.1534], '55122': [44.8108, -93.1534],
  '55123': [44.8108, -93.0834], '55124': [44.7547, -93.2284], '55125': [44.9339, -92.9934],
  '55126': [45.0817, -93.1534], '55127': [45.1168, -93.1100], '55128': [44.9936, -92.9534],
  '55129': [44.9339, -92.9234], '55303': [45.3670, -93.4109], '55304': [45.2678, -93.3769],
  '55305': [44.9936, -93.4769], '55306': [44.7547, -93.3210], '55317': [44.7930, -93.5534],
  '55318': [44.7930, -93.4109], '55337': [44.7287, -93.3210], '55344': [44.8648, -93.4769],
  '55345': [44.9006, -93.4769], '55346': [44.9339, -93.4769], '55347': [44.8648, -93.5534],
  '55369': [45.1168, -93.4769], '55372': [44.6587, -93.3769], '55374': [45.1928, -93.5534],
  '55379': [44.7287, -93.4769], '55391': [44.9936, -93.5534], '55392': [44.9597, -93.5534],
}

// ─────────────────────────────────────────────
// HASH ROUTER
// ─────────────────────────────────────────────
function useRoute() {
  const [hash, setHash] = useState(window.location.hash || '#/')
  useEffect(() => {
    const handler = () => setHash(window.location.hash || '#/')
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])
  return hash
}

function navigate(path) {
  window.location.hash = path
}

function parseHash(hash) {
  const [path, qs] = hash.replace('#', '').split('?')
  const params = new URLSearchParams(qs || '')
  return { path: path || '/', params }
}

// ─────────────────────────────────────────────
// ICONS (inline SVG — no dependency)
// ─────────────────────────────────────────────
const Icon = {
  search: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
  pin: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>,
  clock: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  dollar: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  bolt: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  back: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>,
  phone: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.87 12.26 19.79 19.79 0 0 1 1.81 3.67 2 2 0 0 1 3.78 1.5h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.77-1.77a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>,
  mail: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>,
  link: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
}

// ─────────────────────────────────────────────
// NAV
// ─────────────────────────────────────────────
function Nav() {
  return (
    <nav>
      <div className="nav-inner">
        <button className="nav-logo" onClick={() => navigate('#/')}>
          MN <span>Parkinson's Connect</span>
        </button>
        <button className="btn btn-outline" style={{fontSize:'0.82rem'}} onClick={() => navigate('#/search')}>
          Find Activities
        </button>
      </div>
    </nav>
  )
}

// ─────────────────────────────────────────────
// HOME PAGE
// ─────────────────────────────────────────────
function Home() {
  const [q, setQ] = useState('')
  const [zip, setZip] = useState('')
  const [types, setTypes] = useState([])

  useEffect(() => {
    fetchActivities().then(acts => {
      const seen = new Set()
      acts.forEach(a => a.type && seen.add(a.type))
      setTypes([...seen].sort().slice(0, 8))
    }).catch(() => {})
  }, [])

  const handleSearch = (e) => {
    e.preventDefault()
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    if (zip) p.set('zip', zip)
    navigate(`#/search?${p.toString()}`)
  }

  return (
    <div>
      <section className="hero">
        <div className="hero-eyebrow">Supported by APDA & Parkinson's Foundation</div>
        <h1>Find Your <em>Community</em> in Minnesota</h1>
        <p>Connecting people with Parkinson's and their caregivers to local activities, support groups, and resources across the state.</p>

        <form className="search-box" onSubmit={handleSearch}>
          <input
            type="text"
            placeholder="Search by activity, e.g. Boxing, Yoga..."
            value={q}
            onChange={e => setQ(e.target.value)}
          />
          <div className="divider" />
          <input
            className="zip-input"
            type="text"
            placeholder="Zip Code"
            value={zip}
            onChange={e => setZip(e.target.value)}
            maxLength={5}
          />
          <button type="submit" className="btn btn-primary">Search</button>
        </form>
      </section>

      <section className="categories container">
        <h2>Browse by Category</h2>
        {types.length > 0 ? (
          <div className="cat-grid">
            {types.map(type => (
              <div
                key={type}
                className="cat-card"
                onClick={() => navigate(`#/search?type=${encodeURIComponent(type)}`)}
              >
                {type}
              </div>
            ))}
          </div>
        ) : (
          <div className="state-msg"><div className="spinner" /><p>Loading categories…</p></div>
        )}
      </section>

      <footer>
        <strong>MN Parkinson's Connect</strong> — A collaborative initiative of APDA Minnesota &amp; Parkinson's Foundation.<br />
        <span style={{marginTop:'0.5rem',display:'inline-block'}}>Questions? <a href="mailto:info@mnparkinsons.org" style={{color:'#60A5FA'}}>info@mnparkinsons.org</a></span>
      </footer>
    </div>
  )
}

// ─────────────────────────────────────────────
// SEARCH RESULTS PAGE
// ─────────────────────────────────────────────
const INTENSITIES = ['Light', 'Moderate', 'High']
const COSTS       = ['Free', 'Paid', 'First Session Free']
const FORMATS     = ['In-Person', 'Virtual', 'Hybrid']
const TIMES       = ['Morning', 'Afternoon', 'Evening']

function SearchResults({ params }) {
  const [activities, setActivities] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activityTypes, setActivityTypes] = useState([])

  // filter state
  const [q, setQ] = useState(params.get('q') || '')
  const [zip, setZip] = useState(params.get('zip') || '')
  const [selType, setSelType] = useState(params.get('type') || '')
  const [selIntensity, setSelIntensity] = useState(params.get('intensity') || '')
  const [selCost, setSelCost] = useState(params.get('cost') || '')
  const [selFormat, setSelFormat] = useState(params.get('format') || '')
  const [selTime, setSelTime] = useState(params.get('time') || '')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchActivities({
        q: params.get('q') || undefined,
        zip: params.get('zip') || undefined,
        type: params.get('type') || undefined,
        intensity: params.get('intensity') || undefined,
        cost: params.get('cost') || undefined,
        format: params.get('format') || undefined,
        timeOfDay: params.get('time') || undefined,
      })
      setActivities(data)
      // Collect unique types from results
      const seen = new Set()
      data.forEach(a => a.type && seen.add(a.type))
      if (seen.size > 0) setActivityTypes([...seen].sort())
    } catch(e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [params.toString()])

  useEffect(() => { load() }, [load])

  const applyFilters = () => {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    if (zip) p.set('zip', zip)
    if (selType) p.set('type', selType)
    if (selIntensity) p.set('intensity', selIntensity)
    if (selCost) p.set('cost', selCost)
    if (selFormat) p.set('format', selFormat)
    if (selTime) p.set('time', selTime)
    navigate(`#/search?${p.toString()}`)
  }

  const clearFilters = () => {
    setSelType(''); setSelIntensity(''); setSelCost('')
    setSelFormat(''); setSelTime(''); setZip(''); setQ('')
    navigate('#/search')
  }

  const FilterGroup = ({ title, options, value, onChange }) => (
    <>
      <div className="filter-title">{title}</div>
      {options.map(opt => (
        <label key={opt} className="filter-option">
          <input
            type="radio"
            name={title}
            checked={value === opt}
            onChange={() => onChange(value === opt ? '' : opt)}
          />
          {opt}
        </label>
      ))}
    </>
  )

  return (
    <div>
      <div className="search-header">
        <div className="search-header-inner">
          <input
            type="text"
            placeholder="Search activities..."
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyFilters()}
          />
          <input
            className="zip"
            type="text"
            placeholder="Zip Code"
            value={zip}
            onChange={e => setZip(e.target.value)}
            maxLength={5}
          />
          <button className="btn btn-primary" onClick={applyFilters}>Search</button>
        </div>
      </div>

      <div className="results-layout">
        {/* Filters sidebar */}
        <aside className="filters-panel">
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'0.5rem'}}>
            <strong style={{fontSize:'0.95rem'}}>Filters</strong>
            {(selType||selIntensity||selCost||selFormat||selTime) && (
              <button onClick={clearFilters} style={{fontSize:'0.78rem',color:'var(--blue)',fontWeight:600}}>Clear all</button>
            )}
          </div>

          <FilterGroup title="Activity Type" options={activityTypes.length ? activityTypes : ['Boxing','Yoga','Singing','Cardio']} value={selType} onChange={v => { setSelType(v) }} />
          <FilterGroup title="Intensity" options={INTENSITIES} value={selIntensity} onChange={setSelIntensity} />
          <FilterGroup title="Cost" options={COSTS} value={selCost} onChange={setSelCost} />
          <FilterGroup title="Format" options={FORMATS} value={selFormat} onChange={setSelFormat} />
          <FilterGroup title="Time of Day" options={TIMES} value={selTime} onChange={setSelTime} />

          <button className="btn btn-primary" style={{width:'100%',marginTop:'1rem'}} onClick={applyFilters}>
            Apply Filters
          </button>
        </aside>

        {/* Results */}
        <main>
          {loading ? (
            <div className="state-msg"><div className="spinner"/><p>Loading activities…</p></div>
          ) : error ? (
            <div className="state-msg" style={{color:'#DC2626'}}>
              <p><strong>Error:</strong> {error}</p>
              <p style={{marginTop:'0.5rem',fontSize:'0.85rem'}}>Check that your AIRTABLE_PAT is set in your .env file.</p>
            </div>
          ) : (
            <>
              <p className="results-meta">
                <strong>{activities.length}</strong> {activities.length === 1 ? 'activity' : 'activities'} found
                {params.get('zip') && ` near ${params.get('zip')}`}
                {params.get('q') && ` matching "${params.get('q')}"`}
              </p>
              {activities.length === 0 ? (
                <div className="state-msg">
                  <p>No activities match your filters.</p>
                  <button style={{marginTop:'0.75rem',color:'var(--blue)',fontWeight:600}} onClick={clearFilters}>Clear filters</button>
                </div>
              ) : (
                <div className="activity-list">
                  {activities.map(a => <ActivityCard key={a.id} activity={a} />)}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      <footer>
        <strong>MN Parkinson's Connect</strong> — A collaborative initiative of APDA Minnesota &amp; Parkinson's Foundation.
      </footer>
    </div>
  )
}

function ActivityCard({ activity: a }) {
  return (
    <div className="activity-card" onClick={() => navigate(`#/activity/${a.id}`)}>
      <div className="card-top">
        <div>
          <div className="card-name">{a.name}</div>
          <div className="card-location">
            {a.format === 'Virtual' ? '🌐 Virtual' : <><Icon.pin /> {a.location || a.address || a.zip}</>}
          </div>
        </div>
        <span className={`badge ${a.costCategory === 'Free' ? 'green' : 'blue'}`}>
          <Icon.dollar />{a.costCategory || a.costDisplay || '—'}
        </span>
      </div>
      <div className="card-meta">
        {a.schedule && <span className="badge"><Icon.clock />{a.schedule.split(',')[0]}</span>}
        {a.intensity && <span className="badge"><Icon.bolt />{a.intensity}</span>}
        {a.type && <span className="badge blue">{a.type}</span>}
        {a.dist && a.dist < 9999 && <span className="badge">{a.dist.toFixed(1)} mi</span>}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// ACTIVITY DETAIL PAGE
// ─────────────────────────────────────────────
function ActivityDetail({ id }) {
  const [activity, setActivity] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    fetchActivityById(id)
      .then(setActivity)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="state-msg" style={{padding:'4rem'}}><div className="spinner"/><p>Loading…</p></div>
  if (error) return <div className="state-msg" style={{padding:'4rem',color:'#DC2626'}}><p>{error}</p><button style={{marginTop:'1rem',color:'var(--blue)',fontWeight:600}} onClick={()=>navigate('#/search')}>← Back to search</button></div>
  if (!activity) return null

  const a = activity

  const Row = ({ label, value }) => value ? (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  ) : null

  return (
    <div>
      <div className="detail-wrap">
        <button className="detail-back" onClick={() => navigate('#/search')}>
          <Icon.back /> Back to results
        </button>

        <div className="detail-tags">
          {a.type && <span className="badge blue">{a.type}</span>}
          {a.format && <span className="badge">{a.format}</span>}
          {a.status === 'Active' && <span className="badge green">Active</span>}
        </div>

        <h1 className="detail-title">{a.name}</h1>
        <p className="detail-venue">
          {a.format === 'Virtual' ? '🌐 Virtual Activity' : a.location}
        </p>

        <div className="detail-grid">
          {/* Left column */}
          <div>
            <div className="info-card">
              <h3>Schedule & Logistics</h3>
              <Row label="Days & Times" value={a.schedule} />
              <Row label="Days of Week" value={a.daysOfWeek} />
              <Row label="Time of Day" value={a.timeOfDay} />
              <Row label="Intensity" value={a.intensity} />
              <Row label="Format" value={a.format} />
              <Row label="Caregiver Friendly" value={a.caregiverFriendly} />
            </div>

            <div className="info-card">
              <h3>Location</h3>
              <Row label="Venue" value={a.location} />
              <Row label="Address" value={a.format !== 'Virtual' ? a.address : null} />
              <Row label="Zip Code" value={a.format !== 'Virtual' ? a.zip : null} />
              {a.lat && a.lng && a.format !== 'Virtual' && (
                <div className="info-row">
                  <span className="info-label">Map</span>
                  <a
                    className="info-value"
                    style={{color:'var(--blue)',fontWeight:500}}
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.address || a.location)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open in Google Maps ↗
                  </a>
                </div>
              )}
            </div>

            <div className="info-card">
              <h3>Contact</h3>
              <Row label="Contact" value={a.contact} />
              {a.phone && (
                <div className="info-row">
                  <span className="info-label">Phone</span>
                  <a className="info-value" href={`tel:${a.phone}`} style={{color:'var(--blue)',fontWeight:500}}>
                    <Icon.phone /> {a.phone}
                  </a>
                </div>
              )}
              {a.email && (
                <div className="info-row">
                  <span className="info-label">Email</span>
                  <a className="info-value" href={`mailto:${a.email}`} style={{color:'var(--blue)',fontWeight:500}}>
                    <Icon.mail /> {a.email}
                  </a>
                </div>
              )}
              {a.website && a.website !== 'N/A' && (
                <div className="info-row">
                  <span className="info-label">Website</span>
                  <a className="info-value" href={a.website.startsWith('http') ? a.website : `https://${a.website}`} target="_blank" rel="noopener noreferrer" style={{color:'var(--blue)',fontWeight:500}}>
                    <Icon.link /> Visit website ↗
                  </a>
                </div>
              )}
            </div>
          </div>

          {/* Right sidebar */}
          <div>
            <div className="sidebar-card">
              <div style={{fontSize:'0.78rem',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',marginBottom:'0.5rem'}}>Cost</div>
              <div className="cost-display">
                {a.costCategory === 'Free' ? 'Free' : a.costDisplay || a.costCategory || '—'}
              </div>
              {a.costDisplay && a.costCategory && a.costCategory !== a.costDisplay && (
                <p style={{fontSize:'0.82rem',color:'var(--muted)',marginTop:'0.35rem'}}>{a.costDisplay}</p>
              )}
              {a.registrationLink && a.registrationLink !== 'N/A' && (
                <a
                  className="register-btn"
                  href={a.registrationLink.startsWith('http') ? a.registrationLink : `https://${a.registrationLink}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Register / Sign Up ↗
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      <footer>
        <strong>MN Parkinson's Connect</strong> — A collaborative initiative of APDA Minnesota &amp; Parkinson's Foundation.
      </footer>
    </div>
  )
}

// ─────────────────────────────────────────────
// APP ROOT
// ─────────────────────────────────────────────
export default function App() {
  const hash = useRoute()
  const { path, params } = parseHash(hash)

  let page
  if (path === '/' || path === '') {
    page = <Home />
  } else if (path === '/search') {
    page = <SearchResults params={params} />
  } else if (path.startsWith('/activity/')) {
    const id = path.replace('/activity/', '')
    page = <ActivityDetail id={id} />
  } else {
    page = <Home />
  }

  return (
    <>
      <Nav />
      {page}
    </>
  )
}
