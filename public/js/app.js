const token = localStorage.getItem('token')
if(!token){ window.location.href = '/' }

const socket = io()
socket.emit('auth', { token })

const friendsEl = document.getElementById('friends')
const searchEmailEl = document.getElementById('search-email')
const searchResultEl = document.getElementById('search-result')
const messagesEl = document.getElementById('messages')
const chatPanelEl = document.getElementById('chat-panel')
const emptyStateEl = document.getElementById('empty-state')
const chatPeerEl = document.getElementById('chat-peer')
const logoutBtn = document.getElementById('logout')

let me = null
let currentPeer = null
let friends = []

async function api(path, opts={}){
	const res = await fetch(path, { ...opts, headers: { 'Content-Type':'application/json', Authorization: 'Bearer ' + token, ...(opts.headers||{}) } })
	if(res.status === 401){ localStorage.removeItem('token'); window.location.href='/' }
	return res
}

async function loadMe(){
	const res = await api('/api/me')
	const data = await res.json()
	me = data.user
}

async function loadFriends(){
	const res = await api('/api/friends')
	const data = await res.json()
	friends = data.friends
	renderFriends()
}

function renderFriends(){
	friendsEl.innerHTML = ''
	for(const f of friends){
		const li = document.createElement('li')
		li.textContent = f.email
		li.onclick = () => openChat(f)
		const btnRemove = document.createElement('button')
		btnRemove.textContent = 'Remove'
		btnRemove.onclick = async (e) => { e.stopPropagation(); await api('/api/friends/remove', { method: 'POST', body: JSON.stringify({ friendId: f.id }) }); await loadFriends(); if(currentPeer?.id===f.id){ closeChat() } }
		li.appendChild(btnRemove)
		friendsEl.appendChild(li)
	}
}

async function openChat(peer){
	currentPeer = peer
	chatPeerEl.textContent = peer.email
	emptyStateEl.classList.add('hidden')
	chatPanelEl.classList.remove('hidden')
	await loadMessages()
}

function closeChat(){
	currentPeer = null
	messagesEl.innerHTML = ''
	chatPanelEl.classList.add('hidden')
	emptyStateEl.classList.remove('hidden')
}

async function loadMessages(){
	const res = await api(`/api/messages/${currentPeer.id}`)
	const data = await res.json()
	renderMessages(data.messages)
}

function renderMessages(msgs){
	messagesEl.innerHTML = ''
	for (const m of msgs){
		const div = document.createElement('div')
		div.className = 'message ' + (m.fromId === me.id ? 'me' : 'them')
		if(m.text){
			const p = document.createElement('div')
			p.textContent = m.text
			div.appendChild(p)
		}
		if(m.imageUrl){
			const img = document.createElement('img')
			img.src = m.imageUrl
			div.appendChild(img)
		}
		messagesEl.appendChild(div)
	}
	messagesEl.scrollTop = messagesEl.scrollHeight
}

// Search/add friend by email on Enter
searchEmailEl.addEventListener('keydown', async (e) => {
	if(e.key === 'Enter'){
		e.preventDefault()
		const email = searchEmailEl.value.trim()
		if(!email) return
		const resUsers = await api('/api/users/search?email=' + encodeURIComponent(email))
		let found = null
		if(resUsers.ok){ const data = await resUsers.json(); found = data.user }
		searchResultEl.innerHTML = ''
		const wrap = document.createElement('div')
		wrap.textContent = found ? found.email : 'No user found'
		if(found){
			const btn = document.createElement('button')
			btn.textContent = 'Add'
			btn.onclick = async () => { await api('/api/friends/add', { method: 'POST', body: JSON.stringify({ email: found.email }) }); await loadFriends() }
			wrap.appendChild(btn)
		}
		searchResultEl.appendChild(wrap)
	}
})

// Message form
const messageForm = document.getElementById('message-form')
const messageInput = document.getElementById('message-input')
const imageFile = document.getElementById('image-file')
messageForm.addEventListener('submit', async (e) => {
	e.preventDefault()
	if(!currentPeer) return
	let imageUrl = ''
	if(imageFile.files[0]){
		const fd = new FormData()
		fd.append('image', imageFile.files[0])
		const up = await fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd })
		const upData = await up.json()
		imageUrl = upData.url
		imageFile.value = ''
	}
	const text = messageInput.value.trim()
	messageInput.value = ''
	const res = await api(`/api/messages/${currentPeer.id}`, { method: 'POST', body: JSON.stringify({ text, imageUrl }) })
	const data = await res.json()
	await loadMessages()
})

// Realtime updates
socket.on('message', (message) => {
	if(!currentPeer) return
	if(message.fromId === currentPeer.id || message.toId === currentPeer.id){
		loadMessages()
	}
})

logoutBtn.onclick = () => { localStorage.removeItem('token'); window.location.href = '/' }

// WebRTC
let rtcPeer = null
let localStream = null
const btnCall = document.getElementById('btn-call')
const localVideo = document.getElementById('localVideo')
const remoteVideo = document.getElementById('remoteVideo')
const incoming = document.getElementById('incoming-call')
const acceptBtn = document.getElementById('accept-call')
const declineBtn = document.getElementById('decline-call')

async function ensureMedia(){
	if(localStream) return localStream
	localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
	localVideo.srcObject = localStream
	return localStream
}

function createPeer(){
	rtcPeer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
	rtcPeer.onicecandidate = (e) => { if(e.candidate && currentPeer){ socket.emit('call:ice-candidate', { toUserId: currentPeer.id, candidate: e.candidate }) } }
	rtcPeer.ontrack = (e) => { remoteVideo.srcObject = e.streams[0] }
	if(localStream){ for (const track of localStream.getTracks()) rtcPeer.addTrack(track, localStream) }
	return rtcPeer
}

btnCall.onclick = async () => {
	if(!currentPeer) return
	await ensureMedia()
	createPeer()
	const offer = await rtcPeer.createOffer()
	await rtcPeer.setLocalDescription(offer)
	socket.emit('call:offer', { toUserId: currentPeer.id, offer })
}

socket.on('call:offer', async ({ fromUserId, offer }) => {
	await ensureMedia()
	currentPeer = friends.find(f => f.id === fromUserId) || { id: fromUserId, email: fromUserId }
	incoming.classList.remove('hidden')
	acceptBtn.onclick = async () => {
		incoming.classList.add('hidden')
		createPeer()
		await rtcPeer.setRemoteDescription(new RTCSessionDescription(offer))
		const answer = await rtcPeer.createAnswer()
		await rtcPeer.setLocalDescription(answer)
		socket.emit('call:answer', { toUserId: fromUserId, answer })
	}
	declineBtn.onclick = () => { incoming.classList.add('hidden') }
})

socket.on('call:answer', async ({ fromUserId, answer }) => {
	if(!rtcPeer) return
	await rtcPeer.setRemoteDescription(new RTCSessionDescription(answer))
})

socket.on('call:ice-candidate', async ({ fromUserId, candidate }) => {
	if(!rtcPeer) return
	try { await rtcPeer.addIceCandidate(new RTCIceCandidate(candidate)) } catch {}
})

// Initialize
;(async function init(){
	await loadMe()
	await loadFriends()
})()