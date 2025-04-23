from flask import Flask, render_template, request, jsonify
from datetime import datetime

app = Flask(__name__)
chat_history = []

@app.route('/')
def index():
    return render_template('chat.html')

@app.route('/send', methods=['POST'])
def send():
    user = request.form.get('user', '').strip()
    message = request.form.get('message', '').strip()
    if user and message:
        timestamp = datetime.now().strftime('%H:%M:%S')
        chat_history.append({'user': user, 'message': message, 'time': timestamp})
    return '', 204  # No content

@app.route('/messages')
def messages():
    return jsonify(chat_history[::-1])  # Newest first

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
