import sqlite3
import os
from contextlib import contextmanager

def _db_path(db_dir):
    return os.path.join(db_dir, 'chat.db')

@contextmanager
def _get_db(db_dir):
    conn = sqlite3.connect(_db_path(db_dir), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    try:
        yield conn
    finally:
        conn.close()

def init_db(db_dir):
    with _get_db(db_dir) as conn:
        c = conn.cursor()
        c.executescript('''
            CREATE TABLE IF NOT EXISTS messages (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                room      TEXT    NOT NULL,
                username  TEXT    NOT NULL,
                text      TEXT    DEFAULT '',
                timestamp TEXT    NOT NULL,
                file_url  TEXT    DEFAULT NULL,
                file_name TEXT    DEFAULT NULL
            );

            CREATE TABLE IF NOT EXISTS reactions (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                msg_id   INTEGER NOT NULL,
                username TEXT    NOT NULL,
                emoji    TEXT    NOT NULL,
                UNIQUE(msg_id, username, emoji),
                FOREIGN KEY(msg_id) REFERENCES messages(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room);
            CREATE INDEX IF NOT EXISTS idx_reactions_msg_id ON reactions(msg_id);
        ''')
        conn.commit()

def get_messages(db_dir, room, limit=50, before_id=None):
    with _get_db(db_dir) as conn:
        c = conn.cursor()
        query = 'SELECT id, username, text, timestamp, file_url, file_name FROM messages WHERE room=?'
        params = [room]
        
        if before_id:
            query += ' AND id < ?'
            params.append(before_id)
        
        query += ' ORDER BY id DESC LIMIT ?'
        params.append(limit)
        
        c.execute(query, params)
        rows = c.fetchall()
        
        if not rows:
            return []

        # Batch fetch reactions for all these messages
        msg_ids = [row['id'] for row in rows]
        placeholders = ','.join(['?'] * len(msg_ids))
        c.execute(
            f'SELECT msg_id, emoji, username FROM reactions WHERE msg_id IN ({placeholders})',
            tuple(msg_ids)
        )
        reactions_rows = c.fetchall()

        # Map reactions to message IDs
        reactions_map = {}
        for r in reactions_rows:
            mid = r['msg_id']
            if mid not in reactions_map:
                reactions_map[mid] = {}
            emoji = r['emoji']
            if emoji not in reactions_map[mid]:
                reactions_map[mid][emoji] = []
            reactions_map[mid][emoji].append(r['username'])

        result = []
        for row in reversed(rows):
            mid = row['id']
            result.append({
                'id':        mid,
                'user':      row['username'],
                'text':      row['text'] or '',
                'time':      row['timestamp'],
                'file_url':  row['file_url'],
                'file_name': row['file_name'],
                'reactions': reactions_map.get(mid, {}),
            })
        return result

def save_message(db_dir, room, username, text, timestamp, file_url=None, file_name=None):
    with _get_db(db_dir) as conn:
        c = conn.cursor()
        c.execute(
            'INSERT INTO messages (room, username, text, timestamp, file_url, file_name) '
            'VALUES (?, ?, ?, ?, ?, ?)',
            (room, username, text or '', timestamp, file_url, file_name)
        )
        msg_id = c.lastrowid
        conn.commit()
        return msg_id

def delete_message(db_dir, msg_id, username):
    with _get_db(db_dir) as conn:
        c = conn.cursor()
        c.execute('SELECT username FROM messages WHERE id=?', (msg_id,))
        row = c.fetchone()
        if row is None or row['username'] != username:
            return False
        c.execute('DELETE FROM messages WHERE id=?', (msg_id,))
        conn.commit()
        return True

def add_reaction(db_dir, msg_id, username, emoji):
    with _get_db(db_dir) as conn:
        conn.execute(
            'INSERT OR IGNORE INTO reactions (msg_id, username, emoji) VALUES (?, ?, ?)',
            (msg_id, username, emoji)
        )
        conn.commit()

def remove_reaction(db_dir, msg_id, username, emoji):
    with _get_db(db_dir) as conn:
        conn.execute(
            'DELETE FROM reactions WHERE msg_id=? AND username=? AND emoji=?',
            (msg_id, username, emoji)
        )
        conn.commit()

def get_reactions(db_dir, msg_id):
    with _get_db(db_dir) as conn:
        c = conn.cursor()
        c.execute('SELECT emoji, username FROM reactions WHERE msg_id=?', (msg_id,))
        rows = c.fetchall()
        result = {}
        for row in rows:
            emoji = row['emoji']
            if emoji not in result:
                result[emoji] = []
            result[emoji].append(row['username'])
        return result
