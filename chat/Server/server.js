const WebSocket = require('ws');

let clientCount = 0;
let rooms = {}; 
// Map each client WebSocket to a Set of room codes it has joined
let clientRooms = new Map(); 
let clientIds = new Map(); // WebSocket -> clientId mapping
let videoPeers = {}; // roomCode -> [clientId1, clientId2] - tracks which clients have video active

const server = new WebSocket.Server({ port: 2000 });

server.on('connection', (ws) => {
    clientCount++;
    const clientId = clientCount;
    clientIds.set(ws, clientId);
    
    console.log(`Client #${clientId} connected`);
    
    ws.send(JSON.stringify({
        type: 'connection',
        clientId: clientId,
        message: `Connected as client #${clientId}`
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            
            switch(data.type) {
                case 'create_room':
                    handleCreateRoom(ws, data.roomCode, clientId);
                    break;
                    
                case 'join_room':
                    handleJoinRoom(ws, data.roomCode, clientId);
                    break;
                    
                case 'leave_room':
                    // Explicitly leave the requested room; if no roomCode is provided,
                    // the handler will remove the client from all rooms
                    handleLeaveRoom(ws, clientId, data.roomCode);
                    break;
                    
                case 'message':
                    handleMessage(ws, data, clientId);
                    break;
                    
                case 'broadcast':
                    handleBroadcast(data.message, clientId);
                    break;
                    
                case 'request_peers':
                    handleRequestPeers(ws, data.roomCode, clientId);
                    break;
                    
                case 'webrtc_offer':
                    handleWebRTCSignaling(ws, data, clientId, 'webrtc_offer');
                    break;
                    
                case 'webrtc_answer':
                    handleWebRTCSignaling(ws, data, clientId, 'webrtc_answer');
                    break;
                    
                case 'webrtc_ice':
                    handleWebRTCSignaling(ws, data, clientId, 'webrtc_ice');
                    break;
                    
                case 'stop_video':
                    handleStopVideo(ws, data.roomCode, clientId);
                    break;
                    
                default:
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Unknown message type'
                    }));
            }
        } catch (error) {
            console.log('Error parsing message:', error.message);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid JSON'
            }));
        }
    });

    ws.on('close', () => {
        console.log(`Client #${clientId} disconnected`);
        // Remove client from all rooms on disconnect
        handleLeaveRoom(ws, clientId);
        clientIds.delete(ws);
    });

    ws.on('error', (error) => {
        console.log(`Client #${clientId} error:`, error.message);
    });
});

function handleCreateRoom(ws, roomCode, clientId) {
    if (!roomCode) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Room code is required'
        }));
        return;
    }
    
    if (rooms[roomCode]) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Room already exists'
        }));
        return;
    }
    
    rooms[roomCode] = [ws];

    // Track that this client has joined this room
    if (!clientRooms.has(ws)) {
        clientRooms.set(ws, new Set());
    }
    clientRooms.get(ws).add(roomCode);
    videoPeers[roomCode] = [];
    
    ws.send(JSON.stringify({
        type: 'room_created',
        roomCode: roomCode,
        message: `Room "${roomCode}" created successfully`,
        memberCount: 1
    }));
    
    console.log(`Client #${clientId} created room: ${roomCode}`);
}

function handleJoinRoom(ws, roomCode, clientId) {
    if (!roomCode) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Room code is required'
        }));
        return;
    }
    
    if (!rooms[roomCode]) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Room does not exist'
        }));
        return;
    }
    
    // Join the requested room without forcing the client to leave other rooms.
    // This allows a single client to participate in multiple rooms concurrently.
    if (!rooms[roomCode].includes(ws)) {
        rooms[roomCode].push(ws);
    }

    if (!clientRooms.has(ws)) {
        clientRooms.set(ws, new Set());
    }
    clientRooms.get(ws).add(roomCode);
    
    if (!videoPeers[roomCode]) {
        videoPeers[roomCode] = [];
    }
    
    ws.send(JSON.stringify({
        type: 'room_joined',
        roomCode: roomCode,
        message: `Joined room "${roomCode}"`,
        memberCount: rooms[roomCode].length
    }));
    
    // Notify others in the room
    broadcastToRoom(roomCode, {
        type: 'user_joined',
        roomCode: roomCode,
        message: `Client #${clientId} joined the room`,
        memberCount: rooms[roomCode].length
    }, ws);
    
    console.log(`Client #${clientId} joined room: ${roomCode}`);
}

function handleLeaveRoom(ws, clientId, roomCode) {
    // If a specific roomCode is provided, leave only that room.
    // If not, remove the client from all rooms it has joined.
    if (roomCode) {
        leaveSingleRoom(ws, clientId, roomCode, true);

        const roomsSet = clientRooms.get(ws);
        if (roomsSet) {
            roomsSet.delete(roomCode);
            if (roomsSet.size === 0) {
                clientRooms.delete(ws);
            }
        }
        return;
    }

    const roomsSet = clientRooms.get(ws);
    if (!roomsSet) return;

    // Leave all rooms without sending "room_left" back to the client
    // (typically used on disconnect)
    roomsSet.forEach(code => {
        leaveSingleRoom(ws, clientId, code, false);
    });

    clientRooms.delete(ws);
}

function leaveSingleRoom(ws, clientId, roomCode, notifyClient) {
    if (!roomCode) return;

    // Remove from video peers
    if (videoPeers[roomCode]) {
        videoPeers[roomCode] = videoPeers[roomCode].filter(id => id !== clientId);
    }

    if (rooms[roomCode]) {
        rooms[roomCode] = rooms[roomCode].filter(client => client !== ws);

        if (notifyClient && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'room_left',
                roomCode: roomCode,
                message: `Left room "${roomCode}"`
            }));
        }

        // Notify others
        broadcastToRoom(roomCode, {
            type: 'user_left',
            roomCode: roomCode,
            leftClientId: clientId,
            message: `Client #${clientId} left the room`,
            memberCount: rooms[roomCode].length
        });

        if (rooms[roomCode].length === 0) {
            delete rooms[roomCode];
            delete videoPeers[roomCode];
            console.log(`Room "${roomCode}" deleted (empty)`);
        }
    }

    console.log(`Client #${clientId} left room: ${roomCode}`);
}

function handleMessage(ws, data, clientId) {
    const roomCode = data.roomCode;
    
    console.log(`Message from Client #${clientId}, Room: ${roomCode}, Message: ${data.message}`);
    
    if (!roomCode || !rooms[roomCode]) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'You are not in this room'
        }));        
        return;
    }
    
    broadcastToRoom(roomCode, {
        type: 'message',
        clientId: clientId,
        roomCode: roomCode,
        message: data.message,
    }, ws);
    
    console.log(`Client #${clientId} sent message to room ${roomCode}: ${data.message}`);
}

function handleBroadcast(message, clientId) {
    server.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'broadcast',
                clientId: clientId,
                message: message,
            }));
        }
    });
    
    console.log(`Client #${clientId} broadcasted: ${message}`);
}

function handleRequestPeers(ws, roomCode, clientId) {
    console.log(`Client #${clientId} requested peers in room ${roomCode}`);
    
    if (!videoPeers[roomCode]) {
        videoPeers[roomCode] = [];
    }
    
    // Add this client to video peers list
    if (!videoPeers[roomCode].includes(clientId)) {
        videoPeers[roomCode].push(clientId);
    }
    
    // Send list of existing video peers (excluding self)
    const peers = videoPeers[roomCode].filter(id => id !== clientId);
    
    ws.send(JSON.stringify({
        type: 'peer_list',
        roomCode: roomCode,
        peers: peers
    }));
    
    console.log(`Sent peer list to Client #${clientId}:`, peers);
    
    // Notify existing video peers about new peer
    broadcastToRoom(roomCode, {
        type: 'new_peer',
        roomCode: roomCode,
        peerId: clientId
    }, ws);
    
    console.log(`Notified other peers about Client #${clientId}`);
}

function handleStopVideo(ws, roomCode, clientId) {
    console.log(`Client #${clientId} stopped video in room ${roomCode}`);
    
    if (videoPeers[roomCode]) {
        videoPeers[roomCode] = videoPeers[roomCode].filter(id => id !== clientId);
    }
    
    // Notify others that this peer stopped video
    broadcastToRoom(roomCode, {
        type: 'user_left',
        roomCode: roomCode,
        leftClientId: clientId,
        message: `Client #${clientId} stopped video`
    }, ws);
}

function handleWebRTCSignaling(ws, data, clientId, signalType) {
    const roomCode = data.roomCode;
    const targetPeer = data.targetPeer;
    
    if (!roomCode || !rooms[roomCode]) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid room for WebRTC signaling'
        }));
        return;
    }
    
    console.log(`WebRTC ${signalType} from Client #${clientId} to Client #${targetPeer} in room ${roomCode}`);
    
    // Find the target peer's WebSocket
    const targetWs = findWebSocketByClientId(targetPeer);
    
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
        console.error(`Target peer ${targetPeer} not found or not connected`);
        return;
    }
    
    // Forward the signaling data to the specific peer
    const signalData = {
        type: signalType,
        roomCode: roomCode,
        fromClientId: clientId
    };
    
    if (signalType === 'webrtc_offer') {
        signalData.offer = data.offer;
    } else if (signalType === 'webrtc_answer') {
        signalData.answer = data.answer;
    } else if (signalType === 'webrtc_ice') {
        signalData.candidate = data.candidate;
    }
    
    targetWs.send(JSON.stringify(signalData));
    console.log(`Forwarded ${signalType} to Client #${targetPeer}`);
}

function findWebSocketByClientId(targetClientId) {
    for (let [ws, id] of clientIds.entries()) {
        if (id === targetClientId) {
            return ws;
        }
    }
    return null;
}

function broadcastToRoom(roomCode, data, excludeWs = null) {
    if (!rooms[roomCode]) {
        console.log(`Room ${roomCode} not found for broadcast`);
        return;
    }
    
    console.log(`Broadcasting to room ${roomCode}, members: ${rooms[roomCode].length}`);
    
    rooms[roomCode].forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

console.log('WebSocket server running on port 2000');
