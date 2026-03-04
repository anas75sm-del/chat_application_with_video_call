let ws;
let clientId = null;
let rooms = {}; 
let peerConnections = {}; // roomCode -> peerId -> { pc, makingOffer, ignoreOffer, polite }
let localStream = null;
let pendingCandidates = {}; // roomCode -> peerId -> [candidates]

const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const globalStatus = document.getElementById('globalStatus');
const globalMessages = document.getElementById('globalMessages');
const globalInput = document.getElementById('globalInput');
const globalSendBtn = document.getElementById('globalSendBtn');

const roomControls = document.getElementById('roomControls');
const roomCodeInput = document.getElementById('roomCodeInput');
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const roomContainer = document.getElementById('roomContainer');
const roomList = document.getElementById('roomList');

const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

connectBtn.addEventListener('click', connectToServer);
disconnectBtn.addEventListener('click', disconnect);
globalSendBtn.addEventListener('click', sendGlobalMessage);
createRoomBtn.addEventListener('click', createRoom);
joinRoomBtn.addEventListener('click', joinRoom);

globalInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendGlobalMessage();
});

function connectToServer() {
    ws = new WebSocket('ws://localhost:2000');
    
    ws.onopen = () => {
        updateStatus('Connected');
        addGlobalMessage('Connected to server', 'system');
        connectBtn.classList.add('hidden');
        disconnectBtn.classList.remove('hidden');
        globalInput.disabled = false;
        globalSendBtn.disabled = false;
        roomControls.style.display = 'block';
        roomList.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">Your active rooms will appear here</p>';
    };
    
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleMessage(data);
        } catch (error) {
            addGlobalMessage('Error: ' + error.message, 'error');
        }
    };
    
    ws.onclose = () => {
        updateStatus('Disconnected');
        addGlobalMessage('Disconnected from server', 'system');
        connectBtn.classList.remove('hidden');
        disconnectBtn.classList.add('hidden');
        globalInput.disabled = true;
        globalSendBtn.disabled = true;
        roomControls.style.display = 'none';
        
        // Clean up all rooms and video connections
        Object.keys(rooms).forEach(roomCode => {
            stopVideo(roomCode);
            if (rooms[roomCode].element) {
                rooms[roomCode].element.remove();
            }
        });
        rooms = {};
        peerConnections = {};
        pendingCandidates = {};
        roomList.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">Connect to manage rooms</p>';
    };
    
    ws.onerror = (error) => {
        addGlobalMessage('WebSocket error', 'error');
        console.error('WebSocket error:', error);
    };
}

function disconnect() {
    if (ws) {
        ws.close();
    }
}

function createRoom() {
    const roomCode = roomCodeInput.value.trim();
    if (!roomCode) {
        alert('Please enter a room code');
        return;
    }
    
    sendToServer({
        type: 'create_room',
        roomCode: roomCode
    });
    
    roomCodeInput.value = '';
}

function joinRoom() {
    const roomCode = roomCodeInput.value.trim();
    if (!roomCode) {
        alert('Please enter a room code');
        return;
    }
    
    sendToServer({
        type: 'join_room',
        roomCode: roomCode
    });
    
    roomCodeInput.value = '';
}

function sendGlobalMessage() {
    const message = globalInput.value.trim();
    if (!message) return;
    
    sendToServer({
        type: 'broadcast',
        message: message
    });
    
    globalInput.value = '';
}

function sendRoomMessage(roomCode) {
    const input = rooms[roomCode].input;
    const message = input.value.trim();
    if (!message) return;
    
    console.log('Sending message to room:', roomCode, message); 
    
    sendToServer({
        type: 'message',
        message: message,
        roomCode: roomCode
    });
    
    addRoomMessage(roomCode, message, 'sent', 'You');
    input.value = '';
}

function leaveRoom(roomCode) {
    stopVideo(roomCode);
    
    sendToServer({
        type: 'leave_room',
        roomCode: roomCode
    });
    
    if (rooms[roomCode] && rooms[roomCode].element) {
        rooms[roomCode].element.remove();
    }
    delete rooms[roomCode];
    
    if (Object.keys(rooms).length === 0) {
        roomList.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">Your active rooms will appear here</p>';
    }
}

function sendToServer(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function handleMessage(data) {
    console.log('Received:', data); 
    
    switch(data.type) {
        case 'connection':
            clientId = data.clientId;
            addGlobalMessage(data.message, 'system');
            break;
            
        case 'room_created':
        case 'room_joined':
            createRoomChat(data.roomCode, data.memberCount);
            addRoomMessage(data.roomCode, data.message, 'system');
            break;
            
        case 'user_joined':
            if (data.roomCode) {
                if (!rooms[data.roomCode]) {
                    createRoomChat(data.roomCode, data.memberCount);
                }
                addRoomMessage(data.roomCode, data.message, 'system');
                updateRoomHeader(data.roomCode, data.memberCount);
            }
            break;
            
        case 'user_left':
            if (data.roomCode && rooms[data.roomCode]) {
                addRoomMessage(data.roomCode, data.message, 'system');
                updateRoomHeader(data.roomCode, data.memberCount);
                
                if (data.leftClientId) {
                    removePeer(data.roomCode, data.leftClientId);
                }
            }
            break;
            
        case 'message':
            if (data.roomCode && rooms[data.roomCode]) {
                if (data.clientId !== clientId) {
                    addRoomMessage(data.roomCode, data.message, 'received', `Client #${data.clientId}`);
                }
            }
            break;

        case 'broadcast':
            addGlobalMessage(`[Client #${data.clientId}]: ${data.message}`, 'received');
            break;
            
        case 'error':
            addGlobalMessage(data.message, 'error');
            break;
            
        case 'room_left':
            if (data.roomCode && rooms[data.roomCode]) {
                addRoomMessage(data.roomCode, data.message, 'system');
            }
            break;
            
        // WebRTC Signaling
        case 'peer_list':
            handlePeerList(data.roomCode, data.peers);
            break;
            
        case 'webrtc_offer':
            handleWebRTCOffer(data.roomCode, data.offer, data.fromClientId);
            break;
            
        case 'webrtc_answer':
            handleWebRTCAnswer(data.roomCode, data.answer, data.fromClientId);
            break;
            
        case 'webrtc_ice':
            handleWebRTCIce(data.roomCode, data.candidate, data.fromClientId);
            break;
            
        case 'new_peer':
            if (data.roomCode && rooms[data.roomCode]?.videoActive) {
                console.log('New peer will connect:', data.peerId);
            }
            break;
    }
}

function createRoomChat(roomCode, memberCount) {
    if (rooms[roomCode]) return; 
    
    const roomDiv = document.createElement('div');
    roomDiv.className = 'room-chat';
    roomDiv.innerHTML = `
        <div class="chat-header">
            ${roomCode}
            <div class="header-actions">
                <button class="video-btn" onclick="toggleVideo('${roomCode}')" title="Start Video Call">
                    Video
                </button>
                <button class="close-room" onclick="leaveRoom('${roomCode}')">Leave</button>
            </div>
        </div>
        <div class="status" id="roomStatus-${roomCode}">
            Members: ${memberCount}
        </div>
        <div class="messages" id="roomMessages-${roomCode}"></div>
        <div class="input-area">
            <div class="input-group">
                <input type="text" id="roomInput-${roomCode}" placeholder="Type your message...">
                <button onclick="sendRoomMessage('${roomCode}')" class="btn-primary">Send</button>
            </div>
        </div>
        <div class="video-container" id="videoContainer-${roomCode}">
            <div class="video-grid" id="videoGrid-${roomCode}">
            </div>
            <div class="video-controls">
                <button class="control-btn" id="audioBtn-${roomCode}" onclick="toggleAudio('${roomCode}')">Mute</button>
                <button class="control-btn" id="videoBtn-${roomCode}" onclick="toggleVideoStream('${roomCode}')">Stop Video</button>
                <button class="control-btn danger" onclick="stopVideo('${roomCode}')">End Call</button>
            </div>
        </div>
    `;
    
    roomContainer.appendChild(roomDiv);
    
    const input = document.getElementById(`roomInput-${roomCode}`);
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendRoomMessage(roomCode);
    });
    
    rooms[roomCode] = {
        element: roomDiv,
        messagesDiv: document.getElementById(`roomMessages-${roomCode}`),
        input: input,
        statusDiv: document.getElementById(`roomStatus-${roomCode}`),
        videoContainer: document.getElementById(`videoContainer-${roomCode}`),
        videoGrid: document.getElementById(`videoGrid-${roomCode}`),
        videoBtn: roomDiv.querySelector('.video-btn'),
        videoActive: false,
        audioEnabled: true,
        videoEnabled: true,
        remoteVideos: {} // Track remote video elements by peer ID
    };
    
    if (Object.keys(rooms).length === 1) {
        roomList.innerHTML = '';
    }
    
    const roomItem = document.createElement('div');
    roomItem.className = 'room-item';
    roomItem.id = `roomItem-${roomCode}`;
    roomItem.innerHTML = `<strong>${roomCode}</strong><br><small>${memberCount} member(s)</small>`;
    roomList.appendChild(roomItem);
}

function updateRoomHeader(roomCode, memberCount) {
    if (rooms[roomCode] && rooms[roomCode].statusDiv) {
        rooms[roomCode].statusDiv.textContent = `Members: ${memberCount}`;
    }
    
    const roomItem = document.getElementById(`roomItem-${roomCode}`);
    if (roomItem) {
        roomItem.innerHTML = `<strong>${roomCode}</strong><br><small>${memberCount} member(s)</small>`;
    }
}

function addGlobalMessage(text, type) {
    const msg = document.createElement('div');
    msg.className = `message msg-${type}`;
    msg.textContent = text;
    globalMessages.appendChild(msg);
    globalMessages.scrollTop = globalMessages.scrollHeight;
}

function addRoomMessage(roomCode, text, type, sender = null) {
    if (!rooms[roomCode]) return;
    
    const msg = document.createElement('div');
    msg.className = `message msg-${type}`;
    
    if (sender) {
        msg.textContent = `${sender}: ${text}`;
    } else {
        msg.textContent = text;
    }
    
    rooms[roomCode].messagesDiv.appendChild(msg);
    rooms[roomCode].messagesDiv.scrollTop = rooms[roomCode].messagesDiv.scrollHeight;
}

function updateStatus(status) {
    globalStatus.textContent = status;
}

// WebRTC Functions - Mesh Network

async function toggleVideo(roomCode) {
    if (!rooms[roomCode]) return;
    
    if (rooms[roomCode].videoActive) {
        stopVideo(roomCode);
    } else {
        await startVideo(roomCode);
    }
}

async function startVideo(roomCode) {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
        
        addLocalVideo(roomCode);
        
        rooms[roomCode].videoContainer.classList.add('active');
        rooms[roomCode].videoBtn.classList.add('active');
        rooms[roomCode].videoActive = true;
        
        if (!peerConnections[roomCode]) {
            peerConnections[roomCode] = {};
        }
        
        if (!pendingCandidates[roomCode]) {
            pendingCandidates[roomCode] = {};
        }
        
        // Request list of peers already in the room with video
        sendToServer({
            type: 'request_peers',
            roomCode: roomCode
        });
        
        addRoomMessage(roomCode, 'Video call started', 'system');
        
    } catch (error) {
        console.error('Error starting video:', error);
        addRoomMessage(roomCode, 'Failed to start video: ' + error.message, 'error');
    }
}

function addLocalVideo(roomCode) {
    const videoWrapper = document.createElement('div');
    videoWrapper.className = 'video-wrapper';
    videoWrapper.id = `video-${roomCode}-local`;
    videoWrapper.innerHTML = `
        <video id="localVideo-${roomCode}" autoplay muted playsinline></video>
        <div class="video-label">You (Client #${clientId})</div>
    `;
    
    rooms[roomCode].videoGrid.appendChild(videoWrapper);
    
    const video = document.getElementById(`localVideo-${roomCode}`);
    video.srcObject = localStream;
    
    updateVideoGrid(roomCode);
}

function stopVideo(roomCode) {
    if (!rooms[roomCode]) return;
    
    sendToServer({
        type: 'stop_video',
        roomCode: roomCode
    });
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    // Close all peer connections for this room
    if (peerConnections[roomCode]) {
        Object.keys(peerConnections[roomCode]).forEach(peerId => {
            if (peerConnections[roomCode][peerId].pc) {
                peerConnections[roomCode][peerId].pc.close();
            }
        });
        delete peerConnections[roomCode];
    }
    
    if (pendingCandidates[roomCode]) {
        delete pendingCandidates[roomCode];
    }
    
    rooms[roomCode].videoGrid.innerHTML = '';
    rooms[roomCode].remoteVideos = {};
    
    rooms[roomCode].videoContainer.classList.remove('active');
    rooms[roomCode].videoBtn.classList.remove('active');
    rooms[roomCode].videoActive = false;
    
    addRoomMessage(roomCode, 'Video call ended', 'system');
}

function handlePeerList(roomCode, peers) {
    console.log('Received peer list for room', roomCode, ':', peers);
    
    if (!rooms[roomCode]?.videoActive) return;
    
    // Create peer connection for each existing peer
    peers.forEach(peerId => {
        if (peerId !== clientId) {
            console.log('Initiating connection to existing peer:', peerId);
            createPeerConnectionAndOffer(roomCode, peerId);
        }
    });
}

async function createPeerConnectionAndOffer(roomCode, peerId) {
    const peerData = createPeerConnection(roomCode, peerId, true);
    
    try {
        peerData.makingOffer = true;
        const offer = await peerData.pc.createOffer();
        await peerData.pc.setLocalDescription(offer);
        
        console.log('Sending offer to peer', peerId);
        sendToServer({
            type: 'webrtc_offer',
            roomCode: roomCode,
            targetPeer: peerId,
            offer: peerData.pc.localDescription
        });
    } catch (error) {
        console.error('Error creating offer:', error);
    } finally {
        peerData.makingOffer = false;
    }
}

function createPeerConnection(roomCode, peerId, isPolite) {
    console.log(`Creating peer connection: room=${roomCode}, peer=${peerId}, polite=${isPolite}`);
    
    if (!peerConnections[roomCode]) {
        peerConnections[roomCode] = {};
    }
    
    if (!pendingCandidates[roomCode]) {
        pendingCandidates[roomCode] = {};
    }
    
    if (peerConnections[roomCode][peerId]) {
        console.log('Peer connection already exists for', peerId);
        return peerConnections[roomCode][peerId];
    }
    
    const pc = new RTCPeerConnection(ICE_SERVERS);
    
    // Perfect negotiation pattern
    const peerData = {
        pc: pc,
        makingOffer: false,
        ignoreOffer: false,
        polite: isPolite
    };
    
    peerConnections[roomCode][peerId] = peerData;
    pendingCandidates[roomCode][peerId] = [];
    
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }
    
    pc.ontrack = (event) => {
        console.log('Received remote track from peer', peerId);
        addRemoteVideo(roomCode, peerId, event.streams[0]);
    };
    
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('Sending ICE candidate to peer', peerId);
            sendToServer({
                type: 'webrtc_ice',
                roomCode: roomCode,
                targetPeer: peerId,
                candidate: event.candidate
            });
        }
    };
    
    pc.onconnectionstatechange = () => {
        console.log(`Peer ${peerId} connection state:`, pc.connectionState);
        if (pc.connectionState === 'connected') {
            console.log('Successfully connected to peer', peerId);
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            console.log('Connection failed/disconnected for peer', peerId);
            setTimeout(() => {
                if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                    removePeer(roomCode, peerId);
                }
            }, 3000);
        }
    };
    
    pc.oniceconnectionstatechange = () => {
        console.log(`Peer ${peerId} ICE state:`, pc.iceConnectionState);
    };
    
    pc.onsignalingstatechange = () => {
        console.log(`Peer ${peerId} signaling state:`, pc.signalingState);
    };
    
    return peerData;
}

function addRemoteVideo(roomCode, peerId, stream) {
    if (!rooms[roomCode]) return;
    
    if (rooms[roomCode].remoteVideos[peerId]) {
        console.log('Updating existing video for peer', peerId);
        rooms[roomCode].remoteVideos[peerId].srcObject = stream;
        return;
    }
    
    console.log('Adding new video element for peer', peerId);
    const videoWrapper = document.createElement('div');
    videoWrapper.className = 'video-wrapper';
    videoWrapper.id = `video-${roomCode}-${peerId}`;
    videoWrapper.innerHTML = `
        <video autoplay playsinline></video>
        <div class="video-label">Client #${peerId}</div>
    `;
    
    rooms[roomCode].videoGrid.appendChild(videoWrapper);
    
    const video = videoWrapper.querySelector('video');
    video.srcObject = stream;
    rooms[roomCode].remoteVideos[peerId] = video;
    
    updateVideoGrid(roomCode);
}

function removePeer(roomCode, peerId) {
    console.log('Removing peer', peerId, 'from room', roomCode);
    
    if (peerConnections[roomCode]?.[peerId]) {
        if (peerConnections[roomCode][peerId].pc) {
            peerConnections[roomCode][peerId].pc.close();
        }
        delete peerConnections[roomCode][peerId];
    }
    
    if (pendingCandidates[roomCode]?.[peerId]) {
        delete pendingCandidates[roomCode][peerId];
    }
    
    const videoElement = document.getElementById(`video-${roomCode}-${peerId}`);
    if (videoElement) {
        videoElement.remove();
    }
    
    if (rooms[roomCode]?.remoteVideos[peerId]) {
        delete rooms[roomCode].remoteVideos[peerId];
    }
    
    updateVideoGrid(roomCode);
}

function updateVideoGrid(roomCode) {
    if (!rooms[roomCode]) return;
    
    const grid = rooms[roomCode].videoGrid;
    const videoCount = grid.children.length;
    
    console.log(`Updating video grid: ${videoCount} videos`);
    
    // Adjust grid layout based on number of videos
    if (videoCount === 1) {
        grid.style.gridTemplateColumns = '1fr';
        grid.style.gridTemplateRows = '1fr';
    } else if (videoCount === 2) {
        grid.style.gridTemplateColumns = '1fr 1fr';
        grid.style.gridTemplateRows = '1fr';
    } else if (videoCount <= 4) {
        grid.style.gridTemplateColumns = '1fr 1fr';
        grid.style.gridTemplateRows = '1fr 1fr';
    } else if (videoCount <= 6) {
        grid.style.gridTemplateColumns = '1fr 1fr 1fr';
        grid.style.gridTemplateRows = '1fr 1fr';
    } else {
        grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
        grid.style.gridTemplateRows = 'auto';
    }
}

async function handleWebRTCOffer(roomCode, offer, fromPeerId) {
    try {
        console.log('Received offer from peer', fromPeerId);
        
        if (!rooms[roomCode]?.videoActive) {
            console.log('Video not active, ignoring offer');
            return;
        }
        
        let peerData = peerConnections[roomCode]?.[fromPeerId];
        
        if (!peerData) {
            peerData = createPeerConnection(roomCode, fromPeerId, false);
        }
        
        const pc = peerData.pc;
        
        // Perfect negotiation pattern
        const offerCollision = (peerData.makingOffer || pc.signalingState !== 'stable');
        
        peerData.ignoreOffer = !peerData.polite && offerCollision;
        
        if (peerData.ignoreOffer) {
            console.log('Ignoring offer due to collision (impolite)');
            return;
        }
        
        console.log('Accepting offer from peer', fromPeerId);
        
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        
        // Process any pending ICE candidates
        if (pendingCandidates[roomCode]?.[fromPeerId]) {
            console.log(`Adding ${pendingCandidates[roomCode][fromPeerId].length} pending ICE candidates`);
            for (const candidate of pendingCandidates[roomCode][fromPeerId]) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (error) {
                    console.error('Error adding pending candidate:', error);
                }
            }
            pendingCandidates[roomCode][fromPeerId] = [];
        }
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        console.log('Sending answer to peer', fromPeerId);
        sendToServer({
            type: 'webrtc_answer',
            roomCode: roomCode,
            targetPeer: fromPeerId,
            answer: answer
        });
        
    } catch (error) {
        console.error('Error handling offer:', error);
    }
}

async function handleWebRTCAnswer(roomCode, answer, fromPeerId) {
    try {
        console.log('Received answer from peer', fromPeerId);
        
        const peerData = peerConnections[roomCode]?.[fromPeerId];
        if (!peerData) {
            console.error('No peer connection found for', fromPeerId);
            return;
        }
        
        const pc = peerData.pc;
        
        if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
            console.log('Remote description set for peer', fromPeerId);
            
            // Process any pending ICE candidates
            if (pendingCandidates[roomCode]?.[fromPeerId]) {
                console.log(`Adding ${pendingCandidates[roomCode][fromPeerId].length} pending ICE candidates`);
                for (const candidate of pendingCandidates[roomCode][fromPeerId]) {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate(candidate));
                    } catch (error) {
                        console.error('Error adding pending candidate:', error);
                    }
                }
                pendingCandidates[roomCode][fromPeerId] = [];
            }
        } else {
            console.warn(`Received answer in wrong state: ${pc.signalingState}`);
        }
        
    } catch (error) {
        console.error('Error handling answer:', error);
    }
}

async function handleWebRTCIce(roomCode, candidate, fromPeerId) {
    try {
        const peerData = peerConnections[roomCode]?.[fromPeerId];
        if (!peerData) {
            console.log('No peer connection for ICE candidate from', fromPeerId);
            return;
        }
        
        const pc = peerData.pc;
        
        // If remote description is not set yet, queue the candidate
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
            console.log('Queueing ICE candidate (remote description not set)');
            if (!pendingCandidates[roomCode][fromPeerId]) {
                pendingCandidates[roomCode][fromPeerId] = [];
            }
            pendingCandidates[roomCode][fromPeerId].push(candidate);
        } else {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            console.log('Added ICE candidate from peer', fromPeerId);
        }
        
    } catch (error) {
        console.error('Error handling ICE candidate:', error);
    }
}

function toggleAudio(roomCode) {
    if (!localStream || !rooms[roomCode]) return;
    
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        rooms[roomCode].audioEnabled = audioTrack.enabled;
        
        const btn = document.getElementById(`audioBtn-${roomCode}`);
        btn.textContent = audioTrack.enabled ? 'Mute' : 'Unmute';
    }
}

function toggleVideoStream(roomCode) {
    if (!localStream || !rooms[roomCode]) return;
    
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        rooms[roomCode].videoEnabled = videoTrack.enabled;
        
        const btn = document.getElementById(`videoBtn-${roomCode}`);
        btn.textContent = videoTrack.enabled ? 'Stop Video' : 'Start Video';
    }
}

// Make functions globally accessible
window.sendRoomMessage = sendRoomMessage;
window.leaveRoom = leaveRoom;
window.toggleVideo = toggleVideo;
window.stopVideo = stopVideo;
window.toggleAudio = toggleAudio;
window.toggleVideoStream = toggleVideoStream;