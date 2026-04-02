import os
import uuid
import json
from datetime import datetime
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.utils import secure_filename
import bleach
import logging
import time
from collections import defaultdict, deque
from database.db import init_db, get_messages, save_message, delete_message, add_reaction, remove_reaction, get_reactions

# ── Config ────────────────────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'static', 'uploads')
DB_DIR = os.path.join(BASE_DIR, 'database')
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'zip'}
ROOMS = json.loads(os.environ.get('ROOMS', '["General", "Help", "Random"]'))

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(DB_DIR, exist_ok=True)

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'chatroom-dev-secret-2025')
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16 MB

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Rate limiting: {room: {user: deque[timestamps]}}
message_rates = defaultdict(lambda: defaultdict(deque))

socketio = SocketIO(app, cors_allowed_origins='*', async_mode='eventlet', ping_timeout=10, ping_interval=5, logger=True, engineio_logger=True)

init_db(DB_DIR)

# online_users[room] = { sid: username }
online_users = {r: {} for r in ROOMS}


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


# ── HTTP Routes ───────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('chat.html', rooms=ROOMS)


@app.route('/messages/<room>')
def api_messages(room):
    if room not in ROOMS:
        return jsonify({'error': 'Unknown room'}), 400
    before_id = request.args.get('before', type=int)
    limit = int(request.args.get('limit', 50))
    return jsonify(get_messages(DB_DIR, room, limit=limit, before_id=before_id))


@app.route('/upload', methods=['POST'])
def api_upload():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    f = request.files['file']
    if not f or f.filename == '':
        return jsonify({'error': 'Empty filename'}), 400
    if not allowed_file(f.filename):
        return jsonify({'error': 'File type not allowed'}), 400
    ext = f.filename.rsplit('.', 1)[1].lower()
    safe_name = secure_filename(f.filename)
    stored_name = f"{uuid.uuid4().hex}.{ext}"
    f.save(os.path.join(UPLOAD_FOLDER, stored_name))
    return jsonify({'url': f'/static/uploads/{stored_name}', 'name': safe_name})


@app.route('/delete/<int:msg_id>', methods=['DELETE'])
def api_delete(msg_id):
    uname = request.args.get('username', '').strip()
    if not uname:
        return jsonify({'error': 'No username'}), 400
    ok = delete_message(DB_DIR, msg_id, uname)
    if ok:
        socketio.emit('message_deleted', {'msg_id': msg_id})
        return '', 204
    return jsonify({'error': 'Forbidden or not found'}), 403


@app.route('/react/<int:msg_id>', methods=['POST'])
def api_react(msg_id):
    data = request.get_json(silent=True) or {}
    uname = data.get('username', '').strip()
    emoji = data.get('emoji', '').strip()
    if not uname or not emoji:
        return jsonify({'error': 'Missing username or emoji'}), 400
    add_reaction(DB_DIR, msg_id, uname, emoji)
    reactions = get_reactions(DB_DIR, msg_id)
    socketio.emit('reactions_update', {'msg_id': msg_id, 'reactions': reactions})
    return jsonify({'reactions': reactions})


@app.route('/unreact/<int:msg_id>', methods=['POST'])
def api_unreact(msg_id):
    data = request.get_json(silent=True) or {}
    uname = data.get('username', '').strip()
    emoji = data.get('emoji', '').strip()
    if not uname or not emoji:
        return jsonify({'error': 'Missing username or emoji'}), 400
    remove_reaction(DB_DIR, msg_id, uname, emoji)
    reactions = get_reactions(DB_DIR, msg_id)
    socketio.emit('reactions_update', {'msg_id': msg_id, 'reactions': reactions})
    return jsonify({'reactions': reactions})


# ── Socket.IO Events ──────────────────────────────────────────────────────────

def _broadcast_user_list(room):
    users = list(set(online_users[room].values()))
    socketio.emit('user_list', {'room': room, 'users': users}, room=room)


@socketio.on('join')
def on_join(data):
    uname = str(data.get('username', 'Anonymous')).strip() or 'Anonymous'
    room = data.get('room', 'General')
    if room not in ROOMS:
        return
    join_room(room)
    online_users[room][request.sid] = uname
    _broadcast_user_list(room)
    emit('system_msg', {'text': f'{uname} joined #{room}'}, room=room)


@socketio.on('leave')
def on_leave(data):
    uname = str(data.get('username', 'Anonymous')).strip()
    room = data.get('room', 'General')
    if room not in ROOMS:
        return
    online_users[room].pop(request.sid, None)
    leave_room(room)
    _broadcast_user_list(room)
    emit('system_msg', {'text': f'{uname} left #{room}'}, room=room)


@socketio.on('disconnect')
def on_disconnect():
    for room in ROOMS:
        if request.sid in online_users[room]:
            uname = online_users[room].pop(request.sid)
            _broadcast_user_list(room)
            socketio.emit('system_msg', {'text': f'{uname} disconnected'}, room=room)
    logger.info(f'User disconnected: {request.sid}')

@socketio.on('connect_error')
def on_connect_error(data):
    logger.error(f'Connect error: {data}')



@socketio.on('send_message')
def on_send_message(data):
    uname = str(data.get('username', 'Anonymous')).strip()[:32] or 'Anonymous'  # Limit length
    room = data.get('room', 'General')
    text = bleach.clean(str(data.get('text', '')).strip())
    file_url = data.get('file_url')
    file_name = data.get('file_name')

    if room not in ROOMS:
        emit('error', {'message': 'Invalid room'}, to=request.sid)
        return
    if not text and not file_url:
        emit('error', {'message': 'Empty message'}, to=request.sid)
        return

    # Rate limiting: 5 messages per 10 seconds per user/room
    now = time.time()
    user_queue = message_rates[room][uname]
    # Append first, then drop timestamps older than 10 seconds
    user_queue.append(now)
    while user_queue and now - user_queue[0] >= 10:
        user_queue.popleft()
    if len(user_queue) > 5:
        emit('error', {'message': 'Slow down! Max 5 messages per 10 seconds.'}, to=request.sid)
        return

    timestamp = datetime.now().strftime('%H:%M')
    msg_id = save_message(DB_DIR, room, uname, text, timestamp, file_url, file_name)
    logger.info(f'Message saved: {msg_id} by {uname} in {room}')

    emit('new_message', {
        'id': msg_id,
        'user': uname,
        'text': text,
        'time': timestamp,
        'file_url': file_url,
        'file_name': file_name,
        'reactions': {}
    }, room=room)


@socketio.on('typing')
def on_typing(data):
    uname = str(data.get('username', '')).strip()
    room = data.get('room', 'General')
    if room not in ROOMS or not uname:
        return
    emit('user_typing', {'username': uname}, room=room, include_self=False)


@socketio.on('stop_typing')
def on_stop_typing(data):
    uname = str(data.get('username', '')).strip()
    room = data.get('room', 'General')
    if room not in ROOMS or not uname:
        return
    emit('user_stop_typing', {'username': uname}, room=room, include_self=False)


if __name__ == '__main__':
    print('\n  ChatRoom running at http://localhost:5000\n')
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)
