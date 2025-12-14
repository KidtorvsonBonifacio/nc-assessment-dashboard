// Central state for the dashboard
let state = { raw: [], filtered: [], deletedIds: new Set(), openQualifications: new Set(), editQualifications: new Set() };
const $ = id => document.getElementById(id);
// API base URL — change here if your backend runs on a different host/port
const API_BASE = 'http://localhost:5000';

function getAuthToken(){
  return (localStorage.getItem('authToken') || localStorage.getItem('token') || '');
}

function getAuthHeaders(extra){
  const h = Object.assign({'Content-Type':'application/json'}, extra || {});
  const token = getAuthToken();
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

function handleAuthResponse(res){
  if (res.status === 401 || res.status === 403){
    // token expired or not authorized — do not redirect to external login
    alert('Session expired or unauthorized. Please re-open the dashboard or obtain a valid token.');
    localStorage.removeItem('authToken');
    localStorage.removeItem('token');
    throw new Error('Not authorized');
  }
  return res;
}

// Deduplicate state.raw entries to avoid double-entries from localStorage+server
function dedupeStateRaw() {
  const byId = new Map();
  const byKey = new Map();
  const result = [];
  for (const r of state.raw) {
    if (!r) continue;
    if (r.id) {
      // prefer server id uniqueness
      if (!byId.has(String(r.id))) {
        byId.set(String(r.id), r);
        result.push(r);
      } else {
        // merge non-empty fields into existing
        const existing = byId.get(String(r.id));
        Object.assign(existing, r);
      }
    } else {
      // fallback key: name|dateAssessed|ncNo
      const key = `${(r.name||'').trim().toLowerCase()}|${(r.dateAssessed||'').trim()}|${(r.ncNo||'').trim()}`;
      if (!byKey.has(key)) {
        byKey.set(key, r);
        result.push(r);
      } else {
        const existing = byKey.get(key);
        Object.assign(existing, r);
      }
    }
  }
  state.raw = result;
}

// Update matching record(s) inside saved local files in localStorage
function updateStoredFileRecord(updated) {
  try {
    const files = JSON.parse(localStorage.getItem('dashboardFiles') || '{}');
    let changed = false;
    Object.keys(files).forEach(key => {
      const entry = files[key];
      if (!entry || !Array.isArray(entry.data)) return;
      for (let i = 0; i < entry.data.length; i++) {
        const r = entry.data[i];
        const k1 = `${(r.name||'').trim().toLowerCase()}|${(r.dateAssessed||'').trim()}|${(r.ncNo||'').trim()}`;
        const k2 = `${(updated.name||'').trim().toLowerCase()}|${(updated.dateAssessed||'').trim()}|${(updated.ncNo||'').trim()}`;
        if (k1 === k2) {
          entry.data[i] = Object.assign({}, entry.data[i], updated);
          changed = true;
        }
      }
      files[key] = entry;
    });
    if (changed) localStorage.setItem('dashboardFiles', JSON.stringify(files));
  } catch (e) {
    console.warn('Could not update stored file record:', e);
  }
}

/* ========== localStorage FUNCTIONS FOR MY FILES ========== */
function saveFileToStorage(fileName, data, sourceFileName) {
  try {
    const files = JSON.parse(localStorage.getItem('dashboardFiles') || '{}');
    files[fileName] = {
      name: fileName,
      sourceFileName: sourceFileName || fileName,  // original filename for DB matching
      data: data,
      timestamp: new Date().toLocaleString()
    };
    localStorage.setItem('dashboardFiles', JSON.stringify(files));
    return true;
  } catch (e) {
    console.error('Error saving file to storage:', e);
    return false;
  }
}

// Helpers for stored files
function getAllStoredFiles() {
  try {
    return JSON.parse(localStorage.getItem('dashboardFiles') || '{}');
  } catch (e) {
    console.error('Error reading stored files:', e);
    return {};
  }
}

function loadFileFromStorage(key) {
  try {
    const files = getAllStoredFiles();
    return files[key] ? files[key].data : null;
  } catch (e) {
    console.error('Error loading file from storage:', e);
    return null;
  }
}

function deleteFileFromStorage(key) {
  try {
    const files = getAllStoredFiles();
    if (files[key]) { delete files[key]; localStorage.setItem('dashboardFiles', JSON.stringify(files)); }
    return true;
  } catch (e) {
    console.error('Error deleting stored file:', e);
    return false;
  }
}

// Load all stored files and merge their records into state.raw
function loadAllStoredFiles() {
  try {
    const files = getAllStoredFiles();
    const allKeys = Object.keys(files || {});
    if (allKeys.length === 0) return false;
    const combined = [];
    allKeys.forEach(k => {
      const data = files[k] && Array.isArray(files[k].data) ? files[k].data : [];
      combined.push(...data);
    });
    state.raw = combined;
    try { dedupeStateRaw(); } catch (e) {}
    console.log('Loaded all stored files. Total records:', state.raw.length);
    initializeFilters();
    renderAll();
    refreshAllCharts();
    try { setLastUpdate(new Date()); } catch (e) {}
    return true;
  } catch (e) {
    console.error('Error loading all stored files:', e);
    return false;
  }
}

// Debug function to show what's in localStorage
function debugShowFiles() {
  const files = getAllStoredFiles();
  console.log('=== DEBUG: All stored files ===');
  console.log(JSON.stringify(files, null, 2));
  Object.keys(files).forEach(key => {
    console.log(`File: ${key}`, {
      name: files[key].name,
      sourceFileName: files[key].sourceFileName,
      recordCount: Array.isArray(files[key].data) ? files[key].data.length : 0,
      timestamp: files[key].timestamp
    });
  });
}

// Migration function: fix old localStorage entries that don't have sourceFileName
function migrateOldFiles() {
  try {
    const files = JSON.parse(localStorage.getItem('dashboardFiles') || '{}');
    let migrated = false;
    
    Object.keys(files).forEach(key => {
      const entry = files[key];
      // If entry doesn't have sourceFileName, try to infer it from the key or name
      if (!entry.sourceFileName) {
        // Extract base name from key (e.g., "mydata_1733000000" -> "mydata")
        let inferredName = key;
        const match = key.match(/^(.+?)_\d+$/);
        if (match) {
          inferredName = match[1];
        }
        // Add common Excel extensions to try
        entry.sourceFileName = inferredName + '.xlsx';
        console.log(`[MIGRATION] Fixed ${key}: sourceFileName set to "${entry.sourceFileName}"`);
        migrated = true;
      }
    });
    
    if (migrated) {
      localStorage.setItem('dashboardFiles', JSON.stringify(files));
      console.log('[MIGRATION] localStorage updated');
    }
  } catch (e) {
    console.error('[MIGRATION] Error migrating files:', e);
  }
}

// Set the Last Data Update element to a given date (or now) in mm/dd/yyyy format
function setLastUpdate(date) {
  const el = $('lastUpdateTime');
  if (!el) return;
  const d = date ? new Date(date) : new Date();
  if (isNaN(d)) return;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  el.textContent = `${mm}/${dd}/${yyyy}`;
}

// [normalizeDate] Handle Excel serial numbers and string dates -> YYYY-MM-DD only (no time)
function normalizeDate(val) {
  if (!val && val !== 0) return '';
  // If already YYYY-MM-DD, return as-is
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  // Handle Excel serial numbers
  if (typeof val === 'number') {
    try { return new Date((val - 25569) * 86400 * 1000).toISOString().split('T')[0]; }
    catch (e) { return String(val); }
  }
  // Parse any other date and extract YYYY-MM-DD only
  const d = new Date(val);
  if (isNaN(d)) return String(val);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// [getVal] Safely get a value from a row using multiple possible header names
function getVal(row, names) {
  if (!row || !names) return '';
  const keys = Object.keys(row || {});
  for (const n of names) {
    const found = keys.find(k => String(k || '').trim().toLowerCase() === String(n || '').toLowerCase());
    if (found) return row[found];
  }
  return '';
}

// [isCertified] Returns true if the result indicates certified/pass
function isCertified(result) {
  if (!result) return false;
  const res = String(result).toLowerCase().trim();
  return ['pass', 'passed', 'qualified', 'certified', 'passed with distinction'].includes(res);
}

// [mapRow] Normalize columns into the shape our UI expects
function mapRow(row) {
  return {
    name: String(getVal(row, ['name', 'full name', 'student name']) || '').trim(),
    gender: String(getVal(row, ['gender', 'sex']) || '').trim(),
    qualification: String(getVal(row, ['qualification', 'course', 'trade']) || '').trim(),
    dateAssessed: normalizeDate(getVal(row, ['date assessed', 'date', 'date_assessed']) || ''),
    assessmentCenter: String(getVal(row, ['assessment center', 'center', 'assessment_center']) || '').trim(),
    assessmentStatus: String(getVal(row, ['assessment status', 'assessment_status', 'assessed']) || '').trim(),
    result: String(getVal(row, ['result', 'status']) || '').trim(),
    ncNo: String(getVal(row, ['nc ii no.', 'nc no.', 'nc number', 'nc ii no', 'nc_no']) || '').trim(),
    school: String(getVal(row, ['school', 'institution', 'school name']) || '').trim(),
  };
}

// Fetch candidate rows from backend and sync into state.raw (conversion for field names)
function fetchCandidatesFromServer() {
  return fetch(API_BASE + '/api/candidates', { headers: getAuthHeaders() })
    .then(handleAuthResponse)
    .then(r => r.json())
    .then(data => {
      if (!Array.isArray(data)) return;
      state.raw = data.map(r => ({
        id: r.id,
        name: r.name,
        gender: r.gender,
        qualification: r.qualification,
        dateAssessed: normalizeDate(r.date_assessed || r.dateAssessed || ''),
        assessmentCenter: r.assessment_center || r.assessmentCenter || '',
        assessmentStatus: r.assessment_status || r.assessmentStatus || '',
        result: r.result,
        ncNo: r.nc_no || r.ncNo || '',
        school: r.school || '',
        source_file: r.source_file || r.sourceFile || ''
      }));
      try { dedupeStateRaw(); } catch (e) {}
      initializeFilters();
      renderAll();
      try { setLastUpdate(new Date()); } catch (e) {}
    })
    .catch(err => console.warn('Could not fetch candidates from server', err));
}

// [getActiveRows] Filter out deleted students from raw data
function getActiveRows() {
  return state.raw.filter((_, idx) => !state.deletedIds.has(idx));
}

// [deleteStudent] Mark a student as deleted by index and trigger re-render (keep qualification boxes open)
function deleteStudent(index) {
  state.deletedIds.add(index);
  renderOverviewCards();
  renderOverviewCharts();
  renderNCResults();
  refreshAllCharts();
}


/* -----------------------------
   DOM Ready: initialize behaviour
   - sidebar, tab switching (improved animation)
   - file uploads
   - filter toggle handlers
   ----------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  // Redirect to login if no auth token is present
  const token = getAuthToken();
  if (!token){
    // No auth token found — do not redirect to login pages to avoid "Cannot GET /login/index.html"
    console.warn('No auth token found — continuing without backend authentication.');
    // proceed without forcing navigation
  }
  console.log('DOM Loaded - Initializing dashboard (enhanced)...');

  // Migrate old localStorage entries that don't have sourceFileName
  migrateOldFiles();

  // Set home page active by default
  const homeBtn = document.querySelector('.nav-btn[data-page="introduction"]');
  if (homeBtn) {
    homeBtn.classList.add('active');
    const homePage = $('page-introduction');
    if (homePage) homePage.classList.add('active');
  }

  // Sidebar toggle (unchanged behaviour)
  const sidebar = $('sidebar');
  const toggleBtn = $('sidebar-toggle');
  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    if (window.innerWidth > 768) sidebar.classList.toggle('hide'); else sidebar.classList.toggle('show');
    // After toggling sidebar, charts can resize incorrectly — refresh them shortly after
    setTimeout(() => { renderAll(); refreshAllCharts(); }, 200);
  });

  // Nav buttons -> switch pages instantly without animations
  const navBtns = document.querySelectorAll('.nav-btn');
  let navTransitioning = false; // flag to prevent rapid double-clicks
  
  navBtns.forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (navTransitioning) return; // prevent rapid clicks
    
    if (btn.classList.contains('active')) return; // already on this page
    const page = btn.dataset.page;
    if (!page) return;

    navTransitioning = true;

    // mark active button
    navBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // hide current page
    const current = document.querySelector('.page.active');
    if (current) {
      current.classList.remove('active');
      current.classList.add('page-exit');
    }

    // show new page
    const targetPage = $(`page-${page}`);
    if (targetPage) {
      targetPage.classList.remove('page-exit');
      targetPage.classList.add('page-enter');
      targetPage.classList.add('active');
    }

    // refresh charts after page is visible
    setTimeout(() => {
      renderAll();
      refreshAllCharts();
      navTransitioning = false; // allow next click
    }, 50);
  }));

  // Add logout button to header if authenticated
  (function addLogoutBtn(){
    const token = getAuthToken();
    if (!token) return;
    const header = document.querySelector('.page-header');
    if (!header) return;
    const btn = document.createElement('button');
    btn.className = 'btn ghost';
    btn.style.marginLeft = '12px';
    btn.textContent = 'Logout';
    btn.addEventListener('click', () => {
      localStorage.removeItem('authToken');
      localStorage.removeItem('token');
      localStorage.removeItem('authRole');
      alert('You have been logged out.');
      location.reload();
    });
    header.appendChild(btn);
  })();

  // prevent rapid double-clicks during tab transitions
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) return;

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const tabID = btn.getAttribute('data-tab');
    const currentTab = document.querySelector('.tab-content.active-tab');
    if (currentTab) {
      currentTab.classList.remove('active-tab');
    }

    const target = $(tabID);
    if (target) {
      target.classList.add('active-tab');
    }

    // Render charts and results
    renderAll();
    refreshAllCharts();
  }));

  /* ========== FILE UPLOAD HANDLERS ========== */
  ['file-input-overview', 'file-input-combined'].forEach(id => {
    const elem = $(id);
    if (!elem) return;
    elem.addEventListener('change', (e) => {
      const file = e.target.files[0]; if (!file) return;
      // Basic extension check to give faster feedback for wrong file types
      const allowed = ['.xlsx', '.xls', '.csv'];
      const lower = (file.name || '').toLowerCase();
      if (!allowed.some(ext => lower.endsWith(ext))) {
        alert('Unsupported file type. Please upload an .xlsx, .xls, or .csv file.');
        return;
      }
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          // Support both ArrayBuffer and binary string results for broader browser compatibility
          const data = event.target.result;
          let wb;
          if (data instanceof ArrayBuffer) {
            wb = XLSX.read(new Uint8Array(data), { type: 'array' });
          } else {
            wb = XLSX.read(data, { type: 'binary' });
          }
          if (!wb || !Array.isArray(wb.SheetNames) || wb.SheetNames.length === 0) throw new Error('No sheets found in workbook');
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws);
          state.raw = rows.map(mapRow);
          // SEND DATA TO BACKEND
          fetch(API_BASE + '/api/import-json', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ rows: state.raw, source_file: file.name })
          })
          .then(handleAuthResponse)
          .then(res => res.json())
          .then(result => {
            console.log('Saved to backend:', result);
            alert('✔ Data successfully saved to server! Inserted: ' + result.inserted);
            // refresh local state from server so imported rows get DB ids
            try { fetchCandidatesFromServer(); } catch (e) { console.warn('fetchCandidatesFromServer not available yet'); }
          })
          .catch(err => {
            console.error('Server error:', err);
            alert('❌ Failed to send data to backend');
          });
          const fileName = file.name.split('.')[0] + '_' + new Date().getTime();
          // Save the file with metadata including the original filename for matching with database
          saveFileToStorage(fileName, state.raw, file.name);
          console.log('File saved to storage:', fileName, 'Original:', file.name);
          
          initializeFilters();
          renderAll();
          refreshAllCharts();
          try { setLastUpdate(new Date()); } catch (e) {}
        } catch (err) {
          console.error('Error loading file:', err);
          // show more helpful info to the user (message + hint)
          const msg = err && err.message ? err.message : String(err);
          alert('Error loading Excel file: ' + msg + '\n\nHint: Use a standard .xlsx/.xls file with a single header row. If your file has merged cells or extra header rows, try the provided template.');
        }
      };
      // Use ArrayBuffer for better compatibility; XLSX accepts 'array' type
      try {
        reader.readAsArrayBuffer(file);
      } catch (e) {
        // fallback for very old browsers
        reader.readAsBinaryString(file);
      }
    });
  });

  // initialize filters (empty dataset OK)
  initializeFilters();

  /* ========== ADMIN GUIDE MODAL ========== */
  const adminGuideLink = $('adminGuideLink');
  const helpModal = $('helpModal');
  const helpModalClose = $('helpModalClose');

    if (adminGuideLink) {
    adminGuideLink.addEventListener('click', (e) => {
      e.preventDefault();
      // populate modal content with the full developer documentation (HTML tags inserted)
      const modalBody = $('helpModalBody');
      if (modalBody) {
        modalBody.innerHTML = `
          <h3>NC Assessment Dashboard — Admin Quick Guide</h3>
          <p>This short guide helps administrators perform common tasks quickly.</p>

          <h4>Quick Start (2 minutes)</h4>
          <ol>
            <li>Start backend (from <code>nc-backend</code>):
              <pre><code>.venv\Scripts\python app.py</code></pre>
            </li>
            <li>Serve frontend (from <code>nc-frontend</code>):
              <pre><code>python -m http.server 8000
# then open http://localhost:8000/d.html</code></pre>
            </li>
          </ol>

          <h4>Common Admin Tasks</h4>
          <ul>
            <li><strong>Upload data:</strong> Use the Upload button and choose an .xlsx/.xls/.csv file.</li>
            <li><strong>View saved files:</strong> Click <em>My Files</em> to preview or load saved files.</li>
            <li><strong>Delete file + its DB records:</strong> In <em>My Files</em> click Delete. This removes the file from localStorage and calls the backend to remove matching DB rows.</li>
            <li><strong>Back up DB:</strong> If you use SQLite, copy <code>nc-backend/nc_dashboard.sqlite</code> before doing bulk deletes.</li>
          </ul>

          <h4>Troubleshooting (quick fixes)</h4>
          <ul>
            <li><strong>Upload failed:</strong> Make sure backend is running at <code>http://127.0.0.1:5000</code>.</li>
            <li><strong>Server errors / 500:</strong> Check the backend console where you started <code>app.py</code> for error details.</li>
          </ul>

          <!-- Admin Quick Guide actions intentionally minimalized (developer docs and sample curl removed) -->
        `;
        

      }
      // show modal
      if (helpModal) helpModal.classList.add('active');
      if (sidebar) sidebar.classList.remove('show'); // close mobile sidebar if open
    });
  }

  // Close modal when X is clicked
  if (helpModalClose) {
    helpModalClose.addEventListener('click', () => {
      if (helpModal) helpModal.classList.remove('active');
    });
  }

  // Close modal when clicking outside the modal content
  if (helpModal) {
    helpModal.addEventListener('click', (e) => {
      if (e.target === helpModal) helpModal.classList.remove('active');
    });
  }

  // Developer Docs modal (always initialized) - open/close independently of Admin Guide
  const devDocsLink = $('devDocsLink');
  const devModal = $('devModal');
  const devModalClose = $('devModalClose');
  if (devDocsLink) {
    devDocsLink.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (devModal) devModal.classList.add('active');
      if (sidebar) sidebar.classList.remove('show');
    });
  }
  if (devModalClose) {
    devModalClose.addEventListener('click', () => { if (devModal) devModal.classList.remove('active'); });
  }
  if (devModal) {
    devModal.addEventListener('click', (e) => { if (e.target === devModal) devModal.classList.remove('active'); });
  }

  /* ========== MY FILES MODAL ========== */
  const myFilesModal = $('myFilesModal');
  const myFilesClose = $('myFilesClose');
  const myFilesBody = $('myFilesBody');

  function renderMyFiles() {
    // look up elements each time to avoid issues with closures or load order
    const myFilesModalEl = $('myFilesModal');
    const myFilesBodyEl = $('myFilesBody');
    const files = getAllStoredFiles();

    if (!myFilesBodyEl) {
      if (myFilesModalEl) myFilesModalEl.classList.remove('active');
      return;
    }

    if (Object.keys(files).length === 0) {
      myFilesBodyEl.innerHTML = '<p class="empty-note">No saved files yet.</p>';
      return;
    }

    // top toolbar: Load All
    let html = '<div style="padding:8px 10px; display:flex; justify-content:space-between; align-items:center; gap:8px;">';
    html += '<div style="font-weight:700; color:#2047b9;">My Files</div>';
    html += '<div><button class="load-all-btn" style="padding:6px 12px; background:#27AE60; color:white; border:none; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;">Load All</button></div>';
    html += '</div>';
    html += '<div style="padding-top:6px;">';
    Object.keys(files).sort().reverse().forEach(key => {
      const file = files[key];
      const recordCount = Array.isArray(file.data) ? file.data.length : 0;
      html += `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:12px; border-bottom:1px solid #eee; cursor:pointer;">
          <div>
            <strong style="color:#2047b9;">${file.name}</strong><br/>
            <small style="color:#999;">Records: ${recordCount} | Saved: ${file.timestamp}</small>
          </div>
          <div style="display:flex; gap:8px;">
            <button class="view-file-btn" data-file="${key}" style="padding:6px 12px; background:#3498DB; color:white; border:none; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;">View</button>
            <button class="delete-file-btn" data-file="${key}" style="padding:6px 12px; background:#e74c3c; color:white; border:none; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;">Delete</button>
          </div>
        </div>
      `;
    });
    html += '</div>';
    myFilesBodyEl.innerHTML = html;

    // Add view listeners
    myFilesBodyEl.querySelectorAll('.view-file-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fileName = btn.dataset.file;
        const data = loadFileFromStorage(fileName);
        if (data) {
          showFilePreview(fileName, data);
        }
      });
    });

    // Load All button listener (loads every saved file and merges records)
    const loadAllBtn = myFilesBodyEl.querySelector('.load-all-btn');
    if (loadAllBtn) {
      loadAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const ok = loadAllStoredFiles();
        if (ok) {
          if (myFilesModalEl) myFilesModalEl.classList.remove('active');
          alert(`Loaded all saved files. Total records: ${state.raw.length}`);
        } else {
          alert('No saved files to load.');
        }
      });
    }

    myFilesBodyEl.querySelectorAll('.delete-file-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fileKey = btn.dataset.file;
        if (!confirm(`Delete file and all its database records?`)) return;
        // Get the source_file name to delete from backend
        const files = getAllStoredFiles();
        const fileEntry = files[fileKey];
        console.log('[DELETE] File entry:', fileEntry);
        console.log('[DELETE] All files in localStorage:', files);
        
        let sourceFile = fileKey;  // fallback to fileKey
        if (fileEntry) {
          sourceFile = fileEntry.sourceFileName || fileEntry.name || fileKey;
        }
        console.log('[DELETE] Using sourceFile:', sourceFile);
        
        // Call backend to delete all candidates with this source_file
        fetch(API_BASE + '/api/candidates/by-source/' + encodeURIComponent(sourceFile), {
          method: 'DELETE',
          headers: getAuthHeaders(),
        })
        .then(handleAuthResponse)
        .then(handleAuthResponse)
        .then(r => r.json())
        .then(resp => {
          console.log('Deleted from server:', resp);
          // Delete from localStorage
          deleteFileFromStorage(fileKey);
          // Re-fetch candidates so UI updates
          try { fetchCandidatesFromServer(); } catch (err) { console.warn(err); }
          // Re-render My Files list
          renderMyFiles();
          const msg = `Deleted file: ${sourceFile}\nRemoved ${resp.deleted || 0} records from database.`;
          if (resp.all_source_files && resp.all_source_files.length > 0) {
            console.log('[DELETE] Database still contains these source_files:', resp.all_source_files);
          }
          alert(msg);
        })
        .catch(err => {
          console.error('Delete error:', err);
          // Still delete locally even if server fails
          deleteFileFromStorage(fileKey);
          renderMyFiles();
          alert('Deleted from local storage. Check server if database not updated.');
        });
      });
    });
  }

  function showFilePreview(fileName, data) {
    const previewModal = document.createElement('div');
    previewModal.className = 'help-modal active';
    previewModal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:3000; display:flex; justify-content:center; align-items:center;';
    
    const recordCount = Array.isArray(data) ? data.length : 0;
    let tableHtml = '<table style="width:100%; border-collapse:collapse; font-size:12px;"><thead><tr style="background:#2047b9; color:white;">';
    
    if (recordCount > 0 && data[0]) {
      const headers = Object.keys(data[0]);
      headers.forEach(h => {
        tableHtml += `<th style="padding:8px; text-align:left; border:1px solid #ddd;">${h}</th>`;
      });
      tableHtml += '</tr></thead><tbody>';
      
      data.forEach((row, idx) => {
        tableHtml += `<tr style="background:${idx % 2 === 0 ? '#f9f9f9' : '#fff'};">`;
        headers.forEach(h => {
          tableHtml += `<td style="padding:8px; border:1px solid #ddd;">${row[h] || ''}</td>`;
        });
        tableHtml += '</tr>';
      });
      tableHtml += '</tbody></table>';
    }

    previewModal.innerHTML = `
      <div class="help-modal-content" style="max-width:90%; max-height:85vh; width:90%;">
        <div class="help-modal-header">
          <h2>${fileName}</h2>
          <button class="help-modal-close" style="cursor:pointer;">&times;</button>
        </div>
        <div style="padding:15px; overflow-y:auto; max-height:calc(85vh - 100px);">
          <p style="margin:0 0 10px 0; color:#666;"><strong>Total Records:</strong> ${recordCount}</p>
          <div style="overflow-x:auto;">${tableHtml}</div>
        </div>
      </div>
    `;

    document.body.appendChild(previewModal);

    const closeBtn = previewModal.querySelector('.help-modal-close');
    closeBtn.addEventListener('click', () => {
      previewModal.remove();
    });

    previewModal.addEventListener('click', (e) => {
      if (e.target === previewModal) previewModal.remove();
    });
  }

  // My Files button listeners
  ['my-files-btn-overview', 'my-files-btn-combined'].forEach(id => {
    const btn = $(id);
    if (btn) {
      btn.addEventListener('click', () => {
        renderMyFiles();
        myFilesModal.classList.add('active');
      });
    }
  });

  // Close My Files modal
  if (myFilesClose) {
    myFilesClose.addEventListener('click', () => {
      myFilesModal.classList.remove('active');
    });
  }

  if (myFilesModal) {
    myFilesModal.addEventListener('click', (e) => {
      if (e.target === myFilesModal) myFilesModal.classList.remove('active');
    });
  }
});


/* -----------------------------
   Filters initialization (labels)
   - only populate Overview and NC filter selects
   - removed per-chart unique filters to keep UI simpler
   ----------------------------- */
function initializeFilters() {
  const years = [...new Set(state.raw.map(r => r.dateAssessed ? r.dateAssessed.split('-')[0] : null).filter(Boolean))].sort();
  const quals = [...new Set(state.raw.map(r => r.qualification || 'Other'))].sort();

  // targets
  const yearOverview = $('filterYearOverview');
  const qualOverview = $('filterQualOverview');
  const yearNC = $('filterYearNC');
  const qualNC = $('filterQualNC');
  // sidebar quick filters (if present)
  const sideYear = $('sideFilterYear');
  const sideQual = $('sideFilterQual');
  const sideApply = $('sideFilterApply');
  const sideReset = $('sideFilterReset');

  // populate year selects
  [yearOverview, yearNC].forEach(sel => {
    if (!sel) return; sel.innerHTML = '<option value="">All Years</option>';
    years.forEach(y => { const opt = document.createElement('option'); opt.value = y; opt.textContent = y; sel.appendChild(opt); });
  });

  // also populate sidebar year select if present
  if (sideYear) {
    sideYear.innerHTML = '<option value="">All Years</option>';
    years.forEach(y => { const opt = document.createElement('option'); opt.value = y; opt.textContent = y; sideYear.appendChild(opt); });
  }

  // populate qualification selects
  [qualOverview, qualNC].forEach(sel => {
    if (!sel) return; sel.innerHTML = '<option value="">All Qualifications</option>';
    quals.forEach(q => { const opt = document.createElement('option'); opt.value = q; opt.textContent = q; sel.appendChild(opt); });
  });

  // also populate sidebar qual select if present
  if (sideQual) {
    sideQual.innerHTML = '<option value="">All Qualifications</option>';
    quals.forEach(q => { const opt = document.createElement('option'); opt.value = q; opt.textContent = q; sideQual.appendChild(opt); });
  }

  // Add change listeners (overview + NC filters update everything)
  [yearOverview, qualOverview, yearNC, qualNC].forEach(sel => {
    if (!sel) return;
    sel.addEventListener('change', () => {
      // If qualification changed, close any open qualification detail boxes
      if (sel === qualOverview || sel === qualNC) {
        state.openQualifications.clear();
        state.editQualifications.clear();
      }
      renderAll(); refreshAllCharts();
    });
  });

  // Keep Overview <-> NC selects in sync: changing one updates the other
  if (yearOverview && yearNC) {
    yearOverview.addEventListener('change', () => { yearNC.value = yearOverview.value; renderAll(); refreshAllCharts(); });
    yearNC.addEventListener('change', () => { yearOverview.value = yearNC.value; renderAll(); refreshAllCharts(); });
  }
  if (qualOverview && qualNC) {
    qualOverview.addEventListener('change', () => { qualNC.value = qualOverview.value; state.openQualifications.clear(); state.editQualifications.clear(); renderAll(); refreshAllCharts(); });
    qualNC.addEventListener('change', () => { qualOverview.value = qualNC.value; state.openQualifications.clear(); state.editQualifications.clear(); renderAll(); refreshAllCharts(); });
  }

  // Sidebar selects: when user changes these, sync to main filters and update
  if (sideYear) {
    sideYear.addEventListener('change', () => {
      if (yearOverview) yearOverview.value = sideYear.value;
      if (yearNC) yearNC.value = sideYear.value;
      renderAll(); refreshAllCharts();
    });
  }
  if (sideQual) {
    sideQual.addEventListener('change', () => {
      if (qualOverview) qualOverview.value = sideQual.value;
      if (qualNC) qualNC.value = sideQual.value;
      // user changed sidebar qualification filter -> close any open qualification boxes
      state.openQualifications.clear(); state.editQualifications.clear();
      renderAll(); refreshAllCharts();
    });
  }

  // Apply / Reset buttons in sidebar
  if (sideApply) {
    sideApply.addEventListener('click', () => {
      if (sideYear && yearOverview) yearOverview.value = sideYear.value;
      if (sideYear && yearNC) yearNC.value = sideYear.value;
      if (sideQual && qualOverview) qualOverview.value = sideQual.value;
      if (sideQual && qualNC) qualNC.value = sideQual.value;
      renderAll(); refreshAllCharts();
    });
  }
  if (sideReset) {
    sideReset.addEventListener('click', () => {
      if (sideYear) sideYear.value = '';
      if (sideQual) sideQual.value = '';
      if (yearOverview) yearOverview.value = '';
      if (yearNC) yearNC.value = '';
      if (qualOverview) qualOverview.value = '';
      if (qualNC) qualNC.value = '';
      renderAll(); refreshAllCharts();
    });
  }

  // Search listener (NC only - Overview has no search)
  const searchNC = $('searchNC');
  if (searchNC) searchNC.addEventListener('keyup', () => { renderAll(); refreshAllCharts(); });
  // Filter toggle buttons removed: filters are kept in the DOM but no toggle UI is provided.
}


/* -----------------------------
   Render pipeline
   ----------------------------- */
function renderAll() {
  renderOverviewCards();
  renderOverviewCharts();
  renderNCResults();
}

// [Overview cards] Candidates / Assessed / Certified
function renderOverviewCards() {
  const rows = applyOverviewFilters();
  // Candidates = all filtered rows (any uploaded student). Use row count.
  // Previously candidate counting used assessmentStatus flags; that caused zero counts
  // when uploaded rows did not include assessmentStatus. We treat every row as a
  // candidate to reflect uploads more accurately.
  const totalCandidates = rows.length;
  // Assessed = those with assessmentStatus 'A' only
  const totalAssessed = rows.filter(r => {
    const s = (r.assessmentStatus || '').toString().trim().toUpperCase();
    return s === 'A';
  }).length;
  const totalCertified = rows.filter(r => isCertified(r.result)).length;
  const overviewCandidates = $('overviewCandidates');
  const overviewAssessed = $('overviewAssessed');
  const overviewCertified = $('overviewCertified');
  if (overviewCandidates) overviewCandidates.textContent = totalCandidates;
  if (overviewAssessed) overviewAssessed.textContent = totalAssessed;
  if (overviewCertified) overviewCertified.textContent = totalCertified;
}

// Apply overview filters (year / qualification only - no search on overview)
function applyOverviewFilters() {
  const yearFilter = $('filterYearOverview') ? $('filterYearOverview').value : '';
  const qualFilter = $('filterQualOverview') ? $('filterQualOverview').value : '';

  return getActiveRows().filter(r => {
    if (yearFilter && !r.dateAssessed?.startsWith(yearFilter)) return false;
    if (qualFilter && r.qualification !== qualFilter) return false;
    return true;
  });
}

// Overview charts (use overview filters for all charts)
function renderOverviewCharts() {
  const rows = applyOverviewFilters();
  renderCertifiedPerQualChart(rows);
  renderGenderDistributionChart(rows);
  renderTrendPerYearChart(rows);
}

/* [Certified per qualification] - uses overview year filter if set */
function renderCertifiedPerQualChart(rows) {
  const yearFilter = $('filterYearOverview') ? $('filterYearOverview').value : '';
  const certified = yearFilter ? rows.filter(r => isCertified(r.result) && r.dateAssessed?.startsWith(yearFilter)) : rows.filter(r => isCertified(r.result));
  const qualGroups = {};
  certified.forEach(r => { const q = r.qualification || 'Other'; qualGroups[q] = (qualGroups[q] || 0) + 1; });
  const labels = Object.keys(qualGroups).sort();
  const data = labels.map(l => qualGroups[l]);
  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];
  renderPieChart('certifiedPerQualChart', data, labels, colors);
}

// [Gender distribution] - uses overview filters
function renderGenderDistributionChart(rows) {
  const filtered = rows; // already filtered by applyOverviewFilters
  const male = filtered.filter(r => (r.gender || '').toLowerCase() === 'male').length;
  const female = filtered.filter(r => (r.gender || '').toLowerCase() === 'female').length;
  renderPieChart('genderDistributionChart', [male, female], ['Male', 'Female'], ['#3498DB', '#E74C3C']);
}

// [Trend per year] - uses overview qualification filter if set
function renderTrendPerYearChart(rows) {
  const qualFilter = $('filterQualOverview') ? $('filterQualOverview').value : '';
  const filtered = qualFilter ? rows.filter(r => r.qualification === qualFilter) : rows;

  // Group strictly by YEAR only. Attempt to parse different date formats robustly,
  // fallback to 'Unknown' and place that label at the end.
  const yearData = {};
  filtered.forEach(r => {
    let year = 'Unknown';
    if (r.dateAssessed) {
      const parts = String(r.dateAssessed).split('-');
      if (parts[0] && parts[0].length === 4 && !isNaN(Number(parts[0]))) {
        year = parts[0];
      } else {
        const d = new Date(r.dateAssessed);
        if (!isNaN(d)) year = String(d.getFullYear());
      }
    }
    if (!yearData[year]) yearData[year] = { candidates: 0, assessed: 0, certified: 0 };
    // Count candidates as any uploaded row for that year
    yearData[year].candidates++;
    // Assessed if assessmentStatus is 'A' only
    const s = (r.assessmentStatus || '').toString().trim().toUpperCase();
    if (s === 'A') yearData[year].assessed++;
    if (isCertified(r.result)) yearData[year].certified++;
  });

  // Numeric sort for years, keep 'Unknown' at the end when present
  const knownYears = Object.keys(yearData).filter(y => y !== 'Unknown' && !isNaN(Number(y))).map(y => Number(y)).sort((a, b) => a - b).map(String);
  const years = knownYears.slice();
  if (yearData['Unknown']) years.push('Unknown');

  const candidates = years.map(y => yearData[y].candidates);
  const assessed = years.map(y => yearData[y].assessed);
  const certified = years.map(y => yearData[y].certified);
  renderBarChart('trendPerYearChart', years, candidates, assessed, certified);
}

/* -----------------------------
   Chart helpers (labels)
   ----------------------------- */
/* [Chart helpers] Pie and Bar charts with error handling */
function renderPieChart(canvasId, data, labels, colors) {
  const canvas = $(canvasId);
  if (!canvas) { console.warn(`Canvas ${canvasId} not found`); return; }
  if (canvas._chartRef) { try { canvas._chartRef.destroy(); } catch (e) {} }
  try {
    // ensure we have enough colors -- generate HSL based colors when palette is short
    const basePalette = Array.isArray(colors) && colors.length ? colors.slice() : [];
    const ensureColor = (i) => {
      if (basePalette[i]) return basePalette[i];
      // generate nice distributed HSL colors
      const h = (i * 47) % 360;
      return `hsl(${h} 65% 55%)`;
    };
    const backgroundColor = labels.map((_, i) => ensureColor(i));

    canvas._chartRef = new Chart(canvas, {
      type: 'pie',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor,
          borderColor: '#fff',
          borderWidth: 2
        }]
      },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          aspectRatio: 1.2,
        plugins: {
          legend: {
            position: 'bottom',
            align: 'start',
            labels: {
              // keep square boxes (default) and slightly larger for clarity
              usePointStyle: false,
              boxWidth: 12,
              padding: 8,
              font: { size: 12, weight: '600' },
              // keep custom labels (include counts) but preserve ordering and clear text
              generateLabels: function(chart) {
                const ds = chart.data.datasets[0];
                return chart.data.labels.map((lbl, i) => ({
                  text: `${lbl} (${ds.data[i] || 0})`,
                  fillStyle: ds.backgroundColor[i],
                  hidden: false,
                  index: i
                }));
              }
            }
          }
        }
      }
    });
  } catch (e) {
    console.error(`Error rendering pie chart ${canvasId}:`, e);
  }
}

function renderBarChart(canvasId, labels, candidates, assessed, certified) {
  const canvas = $(canvasId);
  if (!canvas) { console.warn(`Canvas ${canvasId} not found`); return; }
  if (canvas._chartRef) { try { canvas._chartRef.destroy(); } catch (e) {} }
  try {
    // When there are very few labels (1-3), render bars much wider and avoid forcing a large min-width.
    // When many labels exist, keep horizontal scroll by setting a proportional min-width.
    const labelCount = Array.isArray(labels) ? labels.length : 0;

    // compute max value for dynamic step sizing
    const allValues = [].concat(candidates || [], assessed || [], certified || []);
    const maxValue = allValues.length ? Math.max(...allValues) : 0;
    const stepSize = Math.max(1, Math.ceil(maxValue / 8));

    // layout tuning based on label count
    const parent = canvas.closest('.chart-box') || canvas.parentElement;
    if (parent) {
      let minWidth;
      if (labelCount <= 3) {
        // keep compact for 1-3 years so chart fills the card and doesn't leave huge gaps
        minWidth = Math.max(420, labelCount * 220); // 1 -> 420, 2 -> 440, 3 -> 660
      } else {
        // for many years give ~70px per category (group of bars)
        minWidth = Math.max(900, labelCount * 70);
      }
      parent.style.minWidth = minWidth + 'px';
    }

    // per-label chart appearance
    const categoryPercentage = labelCount <= 3 ? 0.85 : 0.5;
    const barPercentage = labelCount <= 3 ? 0.9 : 0.9;
    const maxBarThickness = labelCount <= 3 ? 120 : 50;
    const aspectRatio = labelCount <= 3 ? 1.2 : 2.2;

    canvas._chartRef = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Candidates', data: candidates, backgroundColor: '#3498DB' },
          { label: 'Assessed', data: assessed, backgroundColor: '#F39C12' },
          { label: 'Certified', data: certified, backgroundColor: '#27AE60' }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        aspectRatio: aspectRatio,
        datasets: {
          bar: {
            categoryPercentage: categoryPercentage,
            barPercentage: barPercentage,
            maxBarThickness: maxBarThickness
          }
        },
        scales: {
          x: {
            ticks: { font: { weight: '700', size: 12 } },
            grid: { display: false }
          },
          y: {
            beginAtZero: true,
            ticks: { stepSize: stepSize },
            grid: { color: 'rgba(0,0,0,0.05)' }
          }
        },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: 'rgba(0,0,0,0.9)',
            padding: 12,
            titleFont: { size: 14, weight: '700' },
            bodyFont: { size: 13 },
            displayColors: true,
            borderColor: '#fff',
            borderWidth: 1,
            callbacks: {
              title: function(context) { return '📊 Year ' + context[0].label; },
              label: function(context) { return '  ' + context.dataset.label + ': ' + context.parsed.y; }
            }
          }
        }
      }
    });
  } catch (e) {
    console.error(`Error rendering bar chart ${canvasId}:`, e);
  }
}


/* [NC Results] Collapsible boxes - no edit/delete buttons */
function renderNCResults() {
  const container = $('ncTableBody'); if (!container) return;
  container.innerHTML = '';

  const yearFilter = $('filterYearNC') ? $('filterYearNC').value : '';
  const qualFilter = $('filterQualNC') ? $('filterQualNC').value : '';
  const searchTerm = $('searchNC') ? $('searchNC').value.toLowerCase() : '';

  // Use raw data directly (no deletion)
  let certified = state.raw.filter(r => isCertified(r.result));
  if (yearFilter) certified = certified.filter(r => r.dateAssessed?.startsWith(yearFilter));
  if (qualFilter) certified = certified.filter(r => r.qualification === qualFilter);
  if (searchTerm) {
    certified = certified.filter(r => (r.name || '').toLowerCase().includes(searchTerm) || (r.gender || '').toLowerCase().includes(searchTerm) || (r.qualification || '').toLowerCase().includes(searchTerm) || (r.assessmentCenter || '').toLowerCase().includes(searchTerm) || (r.dateAssessed || '').includes(searchTerm));
  }

  if (certified.length === 0) { container.innerHTML = '<p class="empty-note">No certified students found.</p>'; return; }

  // group by qualification
  const qualGroups = {};
  certified.forEach(r => {
    const q = r.qualification || 'Other';
    if (!qualGroups[q]) qualGroups[q] = [];
    qualGroups[q].push(r);
  });

  // tracking open qualification boxes (max 1 at a time)
  const maxOpen = 1; const openBoxes = [];

  Object.keys(qualGroups).sort().forEach(qual => {
    const qualRows = qualGroups[qual];
    const qualBox = document.createElement('div'); qualBox.className = 'nc-level-box';
    qualBox.innerHTML = `<div class="nc-header"><h2>${qual}</h2><div class="controls-right"><button class="show-btn">Show Details</button></div></div><div class="year-groups" style="display:none;"></div>`;
    container.appendChild(qualBox);

    const yearGroupsDiv = qualBox.querySelector('.year-groups');
    const showBtn = qualBox.querySelector('.show-btn');

    // Check if this qualification should be open (was previously opened)
    const shouldBeOpen = state.openQualifications.has(qual);

    // populate year sections inside this qualification
      const yearGroups = {};
    qualRows.forEach(r => { const year = r.dateAssessed ? r.dateAssessed.split('-')[0] : 'Unknown'; if (!yearGroups[year]) yearGroups[year] = []; yearGroups[year].push(r); });
    Object.keys(yearGroups).sort((a,b)=>b-a).forEach(year => {
      const yearRows = yearGroups[year].sort((a,b) => (a.name||'').localeCompare(b.name||''));
      const yearSection = document.createElement('div'); yearSection.className = 'year-section';
        // build rows using global index and include DB id when available
        const rowsHtml = yearRows.map((rLocal) => {
          const globalIdx = state.raw.indexOf(rLocal);
          const idAttr = rLocal.id ? `data-id="${rLocal.id}"` : '';
          return `<tr ${idAttr} data-index="${globalIdx}"><td>${rLocal.name||''}</td><td>${rLocal.gender||''}</td><td>${rLocal.qualification||''}</td><td>${rLocal.dateAssessed||''}</td><td>${rLocal.assessmentCenter||''}</td><td class="pass">${rLocal.result||''}</td><td>${rLocal.ncNo||''}</td><td>${rLocal.school||''}</td><td><button class="edit-btn" data-id="${rLocal.id||''}" data-index="${globalIdx}" style="padding:6px 10px; background:#007bff; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:12px; margin-right:4px;">Edit</button><button class="delete-btn" data-id="${rLocal.id||''}" data-index="${globalIdx}" style="padding:6px 10px; background:#dc3545; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:12px;">Delete</button></td></tr>`;
        }).join('');
        yearSection.innerHTML = `<h3>${year}</h3><table><thead><tr><th>Name</th><th>Gender</th><th>Qualification</th><th>Date Assessed</th><th>Assessment Center</th><th>Result</th><th>NC Number</th><th>School</th><th>Actions</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
      yearGroupsDiv.appendChild(yearSection);
    });

    // If this qual was open before, show it
    if (shouldBeOpen) {
      yearGroupsDiv.style.display = 'block';
      showBtn.textContent = 'Hide Details';
      openBoxes.push(qualBox);
    }

    // toggle with max-open enforcement
    showBtn.addEventListener('click', () => {
      const isVisible = yearGroupsDiv.style.display !== 'none';
      if (isVisible) {
        yearGroupsDiv.style.display = 'none'; showBtn.textContent = 'Show Details';
        state.openQualifications.delete(qual);
        const idx = openBoxes.indexOf(qualBox); if (idx !== -1) openBoxes.splice(idx,1);
      } else {
        if (openBoxes.length >= maxOpen) {
          const oldest = openBoxes.shift();
          const oldestPanel = oldest.querySelector('.year-groups');
          const oldestBtn = oldest.querySelector('.show-btn');
          if (oldestPanel) oldestPanel.style.display = 'none';
          if (oldestBtn) oldestBtn.textContent = 'Show Details';
          // Find and remove from open qualifications
          const oldestQual = oldest.querySelector('.nc-header h2')?.textContent;
          if (oldestQual) state.openQualifications.delete(oldestQual);
        }
        yearGroupsDiv.style.display = 'block'; showBtn.textContent = 'Hide Details';
        state.openQualifications.add(qual);
        openBoxes.push(qualBox);
      }
    });


  });
}


/* [Event delegation] Handle Edit/Delete button clicks on NC results table (prefer DB id) */
document.addEventListener('click', function(e) {
  // EDIT button -> open modal to edit fields then save
  if (e.target.classList.contains('edit-btn')) {
    const dataId = e.target.dataset.id;
    const hasId = dataId && dataId !== '';
    let index = -1;
    if (hasId) {
      const id = Number(dataId);
      index = state.raw.findIndex(r => Number(r.id) === id);
    } else {
      index = Number(e.target.dataset.index);
    }
    const candidate = state.raw[index];
    if (!candidate) return;

    // build modal
    const modal = document.createElement('div');
    modal.className = 'help-modal active';
    modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:4000; display:flex; justify-content:center; align-items:center;';

    const formHtml = `
      <div class="help-modal-content" style="max-width:600px; width:95%;">
        <div class="help-modal-header"><h2>Edit Candidate</h2><button class="help-modal-close">&times;</button></div>
        <div style="padding:12px;">
          <label style="display:block; margin-bottom:8px; font-weight:600;">Name</label>
          <input id="edit-name" style="width:100%; padding:8px; margin-bottom:10px;" value="${candidate.name || ''}" />

          <label style="display:block; margin-bottom:8px; font-weight:600;">Gender</label>
          <input id="edit-gender" style="width:100%; padding:8px; margin-bottom:10px;" value="${candidate.gender || ''}" />

          <label style="display:block; margin-bottom:8px; font-weight:600;">Qualification</label>
          <input id="edit-qualification" style="width:100%; padding:8px; margin-bottom:10px;" value="${candidate.qualification || ''}" />

          <label style="display:block; margin-bottom:8px; font-weight:600;">Date Assessed</label>
          <input id="edit-date" type="date" style="width:100%; padding:8px; margin-bottom:10px;" value="${candidate.dateAssessed || ''}" />

          <label style="display:block; margin-bottom:8px; font-weight:600;">Assessment Center</label>
          <input id="edit-center" style="width:100%; padding:8px; margin-bottom:10px;" value="${candidate.assessmentCenter || ''}" />

          <label style="display:block; margin-bottom:8px; font-weight:600;">Result</label>
          <input id="edit-result" style="width:100%; padding:8px; margin-bottom:10px;" value="${candidate.result || ''}" />

          <label style="display:block; margin-bottom:8px; font-weight:600;">NC Number</label>
          <input id="edit-ncno" style="width:100%; padding:8px; margin-bottom:10px;" value="${candidate.ncNo || ''}" />

          <label style="display:block; margin-bottom:8px; font-weight:600;">School</label>
          <input id="edit-school" style="width:100%; padding:8px; margin-bottom:10px;" value="${candidate.school || ''}" />
          <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px;">
            <button class="btn ghost" id="cancel-edit">Cancel</button>
            <button class="btn" id="save-edit">Save</button>
          </div>
        </div>
      </div>`;

    modal.innerHTML = formHtml;
    document.body.appendChild(modal);

    // close handlers
    modal.querySelector('.help-modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('#cancel-edit').addEventListener('click', (ev) => { ev.preventDefault(); modal.remove(); });

    modal.querySelector('#save-edit').addEventListener('click', (ev) => {
      ev.preventDefault();
      const updated = {
        name: modal.querySelector('#edit-name').value.trim(),
        gender: modal.querySelector('#edit-gender').value.trim(),
        qualification: modal.querySelector('#edit-qualification').value.trim(),
        dateAssessed: modal.querySelector('#edit-date').value || '',
        assessmentCenter: modal.querySelector('#edit-center').value.trim(),
        result: modal.querySelector('#edit-result').value.trim(),
        ncNo: modal.querySelector('#edit-ncno').value.trim(),
        school: modal.querySelector('#edit-school').value.trim()
      };

      if (hasId) {
        const id = Number(dataId);
        // send PUT to backend using DB id
        fetch(API_BASE + '/api/candidates/' + encodeURIComponent(id), {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify(updated)
        })
        .then(handleAuthResponse)
        .then(r => r.json())
        .then(resp => {
          // update state and UI
          if (index !== -1) state.raw[index] = Object.assign({}, state.raw[index], updated);
          try { updateStoredFileRecord(updated); } catch(e) {}
          try { dedupeStateRaw(); } catch (e) {}
          try { renderAll(); refreshAllCharts(); } catch(e) {}
          const tr = document.querySelector(`tr[data-id="${id}"]`);
          if (tr) {
            tr.querySelector('td:nth-child(1)').innerText = updated.name;
            tr.querySelector('td:nth-child(6)').innerText = updated.result;
            tr.querySelector('td:nth-child(8)').innerText = updated.school;
          }
          modal.remove();
          alert('Saved changes successfully.');
        })
        .catch(err => {
          console.error('Save error:', err);
          alert('Error saving changes');
        });
      } else {
        // local-only record: attempt to create on server (POST) so we get a DB id
        const createPayload = {
          name: updated.name,
          gender: updated.gender,
          qualification: updated.qualification,
          date_assessed: updated.dateAssessed,
          assessment_center: updated.assessmentCenter,
          result: updated.result,
          nc_no: updated.ncNo,
          school: updated.school,
          source_file: updated.source_file || ''
        };
        fetch(API_BASE + '/api/candidates', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(createPayload)
        })
        .then(handleAuthResponse)
        .then(r => r.json())
        .then(created => {
          // update local state with returned id and all updated values
          if (index !== -1) state.raw[index] = Object.assign({}, state.raw[index], { ...updated, id: created.id });
          try { updateStoredFileRecord(Object.assign({}, updated, { id: created.id })); } catch(e) {}
          try { dedupeStateRaw(); } catch (e) {}
          try { renderAll(); refreshAllCharts(); } catch(e) {}
          const tr = document.querySelector(`tr[data-index="${index}"]`);
          if (tr) {
            tr.setAttribute('data-id', created.id);
            const editBtn = tr.querySelector('.edit-btn');
            const delBtn = tr.querySelector('.delete-btn');
            if (editBtn) editBtn.dataset.id = created.id;
            if (delBtn) delBtn.dataset.id = created.id;
            tr.querySelector('td:nth-child(1)').innerText = updated.name;
            tr.querySelector('td:nth-child(6)').innerText = updated.result;
            tr.querySelector('td:nth-child(8)').innerText = updated.school;
          }
          modal.remove();
          alert('Saved and persisted to server.');
        })
        .catch(err => {
          console.warn('Could not persist new record to server:', err);
          // fallback: update state locally only
          if (index !== -1) state.raw[index] = Object.assign({}, state.raw[index], updated);
          try { updateStoredFileRecord(updated); } catch(e) {}
          const tr = document.querySelector(`tr[data-index="${index}"]`);
          if (tr) {
            tr.querySelector('td:nth-child(1)').innerText = updated.name;
            tr.querySelector('td:nth-child(6)').innerText = updated.result;
            tr.querySelector('td:nth-child(8)').innerText = updated.school;
          }
          modal.remove();
          alert('Saved locally but failed to persist to server.');
        });
      }
    });
  }

  // DELETE button
  if (e.target.classList.contains('delete-btn')) {
    const dataId = e.target.dataset.id;
    const hasId = dataId && dataId !== '';
    let index = -1;
    if (hasId) {
      const id = Number(dataId);
      index = state.raw.findIndex(r => Number(r.id) === id);
    } else {
      index = Number(e.target.dataset.index);
    }
    const candidate = state.raw[index];
    if (!candidate) return;

    if (!confirm(`Delete candidate ${candidate.name}? This cannot be undone.`)) return;

    if (hasId) {
      const id = Number(dataId);
      // Make DELETE request to backend
      fetch(API_BASE + '/api/candidates/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: getAuthHeaders()
      })
      .then(handleAuthResponse)
      .then(r => r.json())
      .then(resp => {
        console.log('Deleted candidate:', resp);
        if (index !== -1) state.raw.splice(index, 1);
        renderNCResults();
        alert('Candidate deleted successfully!');
      })
      .catch(err => {
        console.error('Delete error:', err);
        alert('Error deleting candidate');
      });
    } else {
      // local-only deletion
      if (index !== -1) state.raw.splice(index, 1);
      renderNCResults();
      alert('Record removed locally. To remove from server, ensure that record has been imported to server first.');
    }
  }
});


// Debug fetch removed.


/* -----------------------------

   Chart refresh helper
   ----------------------------- */
function refreshAllCharts() {
  const chartIds = ['certifiedPerQualChart', 'genderDistributionChart', 'trendPerYearChart'];
  chartIds.forEach(id => {
    const el = $(id);
    if (el && el._chartRef) {
      try { el._chartRef.resize(); } catch(e){}
      try { el._chartRef.update(); } catch(e){}
    }
  });
}


/* -----------------------------
   Sample download (kept labeled)
   ----------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  ['download-sample-overview', 'download-sample-combined'].forEach(id => {
    const elem = $(id); if (!elem) return;
    elem.addEventListener('click', () => {
      // Create template with header row only (no sample student rows)
      const headers = ["Name","Gender","Qualification","Date Assessed","Assessment Center","Assessment Status","Result","NC No.","School"];
      const aoa = [headers];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Results');
      XLSX.writeFile(wb, 'Assessment_Template.xlsx');
    });
  });
});

// On initial load try to sync with backend so records have DB ids
document.addEventListener('DOMContentLoaded', () => {
  try { fetchCandidatesFromServer(); } catch (e) { console.warn('fetchCandidatesFromServer not available'); }
});
