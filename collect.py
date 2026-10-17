#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
RKMusic_Ledger の収集スクリプト。cron-job.org が毎時0分に GitHub Actions を起動して動かす。

記録は「一度書いたら書き換えない」。書き換えるのは小さい台帳（catalog.json）と、当日の daily の取り直しだけ。
    channels.json               タレント一覧（名前・チャンネルID・並び順）。手で直す
    flags.json                  手で決めた種別の例外（{タレント: {動画ID: 種別}}）。フラグツールで直す
    catalog.json                全動画の台帳（タレント・タイトル・公開日・長さ・種別・確定したか）とチャンネルの情報
    daily/YYYY/YYYY-MM-DD.json  0時の全件。全動画の [再生数, 高評価数, コメント数] とチャンネルの登録者数など
    hourly/YYYY-MM-DD/HH.json   毎時。前の回から再生数が変わった動画の再生数と、登録者数
    summary/daily_totals.json   RK全体の日ごとの合計（総再生数・種別ごとに増えた再生数）。0時の回と予備の実行で入れ直す小さい台帳
    summary/talents/{名前}.json シンガーごとの日ごとの合計（総再生数・登録者数・種別ごとに増えた再生数）。同じく入れ直す
時刻はすべて日本時間。

回の種類（--mode）:
    auto        日本時間の0時台なら daily、それ以外なら hourly（cron-job.org からはこれで起動する）
    daily       0時の全件。daily と hourly/…/00 を書く
    hourly      毎時。全動画の再生数、登録者数（23チャンネルを1回で）、各チャンネルの新着1ページ
    fill        予備の実行（1:00）。今日の daily が無ければ全件を取り、前日の値で埋めた分があれば取り直す
    test        daily と hourly を続けて動かす。通知はせず、ワークフローも保存しない（GitHub 上での動作確認用）
    alert-test  通知（GitHub の Issue）のテストだけを行う。データには触れない

収集のときはリポジトリ全体を取り込まない。daily/ と hourly/ は手元に無く、読むときに git から1ファイルずつ取り出す。
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import isodate
import requests
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# ----------------------------------------------------------------
# 設定
# ----------------------------------------------------------------
API_KEY = os.environ.get('YOUTUBE_API_KEY')
ROOT = os.path.dirname(os.path.abspath(__file__))
JST = timezone(timedelta(hours=9))

MAX_WORKERS = 10       # Short判定の同時並列数
CHANNEL_WORKERS = 3    # 0時の回でチャンネルを同時に処理する数

LIVE_MIN_SEC = 420     # タブで分からないときの予備。これ以上の長さはライブ、未満は動画
SHORT_MAX_SEC = 180    # ショートは3分まで。これより長い動画はショート判定を省く
PENDING = 'Pending'    # 配信前・配信中など、まだ種別を決められない動画。サイトには出さない

LIST_RETRIES = 2       # 一覧が総件数より少ないときに読み直す回数
DETAIL_RETRIES = 3     # 詳細が返ってこなかった動画を取り直す回数
RETRY_WAIT_SEC = 10    # 読み直し・取り直しの前に待つ秒数（回を重ねるごとに延ばす）
CHANNEL_RETRY_WAIT_SEC = 30  # チャンネルごと失敗したときに取り直すまで待つ秒数
FILL_MARK = '補完'      # 取り切れず、前日の値で埋めたもの
BASE_LOOKBACK_DAYS = 14  # 土台にする daily を探しに戻る日数

CHANNELS_FILE = 'channels.json'
FLAGS_FILE = 'flags.json'
CATALOG_FILE = 'catalog.json'
TOTALS_FILE = 'summary/daily_totals.json'
TALENTS_DIR = 'summary/talents'
TYPES = ('Movie', 'Short', 'LiveArchive')
TAB_PLAYLISTS = (('UULF', 'Movie'), ('UUSH', 'Short'), ('UULV', 'LiveArchive'))

# この実行で取り切れなかった分・解消した分。最後に通知に使う
_report_lock = threading.Lock()
REPORT = {'alerts': [], 'resolved': []}
# API の呼び出し回数（1回1ユニット）。最後にログへ出す
_calls_lock = threading.Lock()
CALLS = {}


def report(kind, value):
    with _report_lock:
        REPORT[kind].append(value)


def daily_path(day):
    return f'daily/{day[:4]}/{day}.json'


def hourly_dir(day):
    return f'hourly/{day}'


def hourly_path(day, hour):
    return f'{hourly_dir(day)}/{hour:02d}.json'


def shift_day(day, days):
    return (datetime.strptime(day, '%Y-%m-%d') + timedelta(days=days)).strftime('%Y-%m-%d')

# ----------------------------------------------------------------
# ファイル読み書き
# ----------------------------------------------------------------

def _git(*args):
    try:
        r = subprocess.run(['git', '-C', ROOT, *args], capture_output=True, check=False)
    except FileNotFoundError:
        return None
    return r.stdout.decode('utf-8') if r.returncode == 0 else None


def read_json(rel, default=None):
    """手元にあればそれを読み、無ければ git の最新のコミットから取り出す（収集では daily/ と hourly/ が手元に無い）"""
    path = os.path.join(ROOT, rel)
    try:
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        text = _git('show', f'HEAD:{rel}')
        return json.loads(text) if text is not None else default
    except Exception as e:
        print(f'⚠️  {rel} を読めませんでした: {e}')
        return default


def list_names(rel_dir):
    """フォルダの中のファイル名。手元と git の最新のコミットの両方から集める"""
    names = set()
    path = os.path.join(ROOT, rel_dir)
    if os.path.isdir(path):
        names |= set(os.listdir(path))
    listed = _git('ls-tree', '--name-only', f'HEAD:{rel_dir}')
    if listed:
        names |= {n for n in listed.split('\n') if n}
    return sorted(n for n in names if n.endswith('.json'))


def exists(rel):
    return os.path.basename(rel) in list_names(os.path.dirname(rel))


def write_json(rel, data, indent=None):
    """一時ファイルに書いてから置き換える。indent を省くと、区切りの空白も省いて詰めて書く"""
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=os.path.dirname(path), delete=False, suffix='.tmp') as f:
        if indent is None:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        else:
            json.dump(data, f, ensure_ascii=False, indent=indent)
            f.write('\n')
        tmp_path = f.name
    os.replace(tmp_path, path)
    print(f'  保存: {rel}')

# ----------------------------------------------------------------
# YouTube API
# ----------------------------------------------------------------

def client():
    """API のクライアント。スレッドをまたいで使えないので、スレッドごとに作る"""
    return build('youtube', 'v3', developerKey=API_KEY, cache_discovery=False)


def execute_with_retry(request, max_retries=3):
    method = getattr(request, 'methodId', '?')
    for attempt in range(max_retries + 1):
        with _calls_lock:
            CALLS[method] = CALLS.get(method, 0) + 1
        try:
            return request.execute()
        except HttpError as e:
            if e.status_code in (500, 503) and attempt < max_retries:
                wait = 2 ** attempt
                print(f'  ⚠️  API {e.status_code}エラー、{wait}秒後にリトライ ({attempt + 1}/{max_retries})')
                time.sleep(wait)
                continue
            raise


def fetch_channels(yt, channels, part):
    """全チャンネルを1回で取る（id はまとめて渡せる。1ユニット）。取れなかったチャンネルは結果に入らない"""
    by_id = {}
    for attempt in range(2):
        try:
            resp = execute_with_retry(yt.channels().list(
                part=part, id=','.join(c['channel_id'] for c in channels)
            ))
            by_id = {item['id']: item for item in resp.get('items', [])}
            break
        except Exception as e:
            print(f'  ⚠️  チャンネル情報の取得に失敗しました ({attempt + 1}/2): {e}')
            if attempt == 0:
                time.sleep(CHANNEL_RETRY_WAIT_SEC)
    return {c['name']: by_id[c['channel_id']] for c in channels if c['channel_id'] in by_id}


def list_upload_ids(yt, playlist_id, name=''):
    """
    アップロードの一覧を最後まで読み、(IDの並び, 総件数, 総件数どおりに読めたか) を返す。
    一覧のAPIが返す総件数（pageInfo.totalResults）より少なければ、少し待って読み直し、読めたIDを足し合わせる。
    2026-10-10 の確認で、総件数は全23チャンネルで実際に受け取れたIDの数と一致した。
    """
    ids, seen, total = [], set(), None
    for attempt in range(LIST_RETRIES + 1):
        token, pages = None, 0
        while True:
            resp = execute_with_retry(yt.playlistItems().list(
                part='contentDetails', playlistId=playlist_id, maxResults=50, pageToken=token
            ))
            if total is None:
                total = resp.get('pageInfo', {}).get('totalResults')
            pages += 1
            for item in resp.get('items', []):
                vid = item['contentDetails']['videoId']
                if vid not in seen:
                    seen.add(vid)
                    ids.append(vid)
            token = resp.get('nextPageToken')
            if not token:
                break
        print(f'  [{name}] 一覧: {len(ids)}本 / 総件数 {total}（{pages}ページ）')
        if total is None or len(ids) >= total:
            return ids, total, True
        if attempt < LIST_RETRIES:
            wait = RETRY_WAIT_SEC * (attempt + 1)
            print(f'  ⚠️  [{name}] 一覧が総件数より{total - len(ids)}本少ないため、{wait}秒後に読み直します ({attempt + 1}/{LIST_RETRIES})')
            time.sleep(wait)
    return ids, total, False


def fetch_details(yt, ids, name='', part='snippet,statistics,liveStreamingDetails,contentDetails'):
    """
    動画の詳細を50本ずつ取る。頼んだIDのうち返ってこなかったものは、少し待って取り直す。
    戻り値は ({動画ID: 詳細}, 最後まで返ってこなかったIDの並び)。
    ページごとの「返ってきた数/頼んだ数」をログに出す（どのページで欠けたかを後から追えるように）。
    """
    got = {}
    pending = list(ids)
    missing = []
    for attempt in range(DETAIL_RETRIES + 1):
        missing, counts = [], []
        for i in range(0, len(pending), 50):
            batch = pending[i:i + 50]
            try:
                resp = execute_with_retry(yt.videos().list(part=part, id=','.join(batch)))
                items = {item['id']: item for item in resp.get('items', [])}
            except Exception as e:
                print(f'  ⚠️  [{name}] 詳細の取得に失敗しました: {e}')
                items = {}
            got.update(items)
            counts.append(f'{len(items)}/{len(batch)}')
            missing += [vid for vid in batch if vid not in items]
        label = '詳細' if attempt == 0 else f'取り直し{attempt}回目'
        print(f'  [{name}] {label}（返ってきた数/頼んだ数）: {" ".join(counts)}')
        if not missing:
            break
        if attempt < DETAIL_RETRIES:
            wait = RETRY_WAIT_SEC * (attempt + 1)
            print(f'  ⚠️  [{name}] {len(missing)}本の詳細が返ってこなかったため、{wait}秒後に取り直します ({attempt + 1}/{DETAIL_RETRIES})')
            time.sleep(wait)
        pending = missing
    return got, missing


def describe_gone(yt, ids):
    """
    一覧から外れた動画について、ログに出すための手がかりを返す（{動画ID: 説明}）。
    IDを指定して取れるか（取れたら公開状態）と、埋め込み情報（oEmbed）の応答コード。
    """
    status = {}
    for i in range(0, len(ids), 50):
        try:
            resp = execute_with_retry(yt.videos().list(part='status', id=','.join(ids[i:i + 50])))
            for item in resp.get('items', []):
                status[item['id']] = item.get('status', {}).get('privacyStatus')
        except Exception:
            pass
    out = {}
    for vid in ids:
        try:
            code = requests.get('https://www.youtube.com/oembed',
                                params={'url': f'https://www.youtube.com/watch?v={vid}', 'format': 'json'},
                                timeout=10).status_code
        except Exception:
            code = '失敗'
        privacy = status.get(vid)
        out[vid] = (f'IDで取れる（{privacy}）' if privacy else 'IDで取れない') + f' / oEmbed {code}'
    return out

# ----------------------------------------------------------------
# 種別の判定
# ----------------------------------------------------------------

def is_short_video(video_id):
    """
    ショートのURLを開き、そのまま表示されればショート、通常の再生ページへ転送されればショートではない。
    どちらとも言えない応答（通信失敗・同意画面への転送など）は None を返し、翌日に判定し直す。
    """
    url = f'https://www.youtube.com/shorts/{video_id}'
    for attempt in range(3):
        try:
            response = requests.head(url, allow_redirects=False, timeout=5)
            if response.status_code == 200:
                return True
            if response.is_redirect and '/watch' in response.headers.get('Location', ''):
                return False
        except Exception:
            pass
        if attempt < 2:
            time.sleep(2 ** attempt)
    return None


def check_shorts_batch(video_ids):
    """複数動画のShort判定を並列実行"""
    results = {}
    if not video_ids:
        return results
    print(f'  並列Short判定: {len(video_ids)}本 ({MAX_WORKERS}並列)')
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_id = {executor.submit(is_short_video, vid): vid for vid in video_ids}
        for future in as_completed(future_to_id):
            vid = future_to_id[future]
            try:
                results[vid] = future.result()
            except Exception:
                results[vid] = None
    failed = sum(1 for v in results.values() if v is None)
    print(f'  Short判定完了: {sum(1 for v in results.values() if v)}本がShort'
          + (f'、{failed}本は判定できず翌日に持ち越し' if failed else ''))
    return results


def get_duration_seconds(video):
    try:
        return int(isodate.parse_duration(video['contentDetails'].get('duration', 'PT0S')).total_seconds())
    except Exception:
        return 0


def classify(duration_sec, live_status, tab_type, short_result):
    """
    自動判定。戻り値は (種別, 確定したか)。flags.json の例外はこの外で優先して当てる。

    1. 配信前・配信中（長さが0）は判定できないので Pending のまま持ち越す。
    2. チャンネルの「動画 / ショート / ライブ」タブのどれに入っているかで決める（確定）。
    3. タブで分からないときだけ、時間で仮に決める。確定はせず、翌日にタブで判定し直す。
       3分以下はショートかを確かめ（確かめられなければ Pending）、それ以外は長さで分ける。
    """
    if live_status in ('upcoming', 'live') or duration_sec <= 0:
        return PENDING, False
    if tab_type:
        return tab_type, True
    if duration_sec <= SHORT_MAX_SEC:
        if short_result is None:
            return PENDING, False
        if short_result:
            return 'Short', False
    return ('LiveArchive' if duration_sec >= LIVE_MIN_SEC else 'Movie'), False


def get_tab_types(yt, channel_id):
    """
    チャンネルページの「動画 / ショート / ライブ」タブの再生リストから、動画ごとの種別を返す。
    再生リストのIDは、チャンネルIDの先頭 UC を UULF / UUSH / UULV に替えたもの。
    YouTube の公式の文書には無い仕組みなので、読めなければ空を返し、呼び出し側が時間で仮に判定する。
    2026-10-04、全23チャンネル9,431本のすべてが、どれか1つのタブにだけ入っていることを確認した。
    """
    result = {}
    for prefix, vtype in TAB_PLAYLISTS:
        token = None
        try:
            while True:
                resp = execute_with_retry(yt.playlistItems().list(
                    part='contentDetails', playlistId=prefix + channel_id[2:], maxResults=50, pageToken=token
                ))
                for item in resp.get('items', []):
                    result[item['contentDetails']['videoId']] = vtype
                token = resp.get('nextPageToken')
                if not token:
                    break
        except HttpError as e:
            if e.status_code == 404:
                # そのタブに1本も無いチャンネルでも起こりうるので、空のタブとして続ける
                print(f'  ⚠️  {prefix} のタブが見つかりません（空として扱います）')
                continue
            print(f'  ⚠️  タブの取得に失敗しました。今日の新しい動画は時間で仮に判定します: {e}')
            return {}
        except Exception as e:
            print(f'  ⚠️  タブの取得に失敗しました。今日の新しい動画は時間で仮に判定します: {e}')
            return {}
    return result

# ----------------------------------------------------------------
# 0時の回: 1チャンネルぶんの収集
# ----------------------------------------------------------------

def collect_channel(channel, uploads, catalog_videos, flags, prev_v):
    """
    1チャンネルの全動画を取って種別を判定する（スレッドから呼ぶ）。
    戻り値は ({動画ID: 動画}, 最後まで詳細が取れなかった動画ID, 一覧の様子)。
    総件数どおりに読めた一覧から外れた動画は、チャンネル側で外されたものとして info['gone'] に入れる。
    """
    name, channel_id = channel['name'], channel['channel_id']
    yt = client()
    known = {vid: c for vid, c in catalog_videos.items() if c.get('タレント') == name}
    active = [vid for vid, c in known.items() if not c.get('外れた日')]

    listed, total, complete = list_upload_ids(yt, uploads, name)
    listed_set = set(listed)
    gone = [vid for vid in active if vid not in listed_set]
    targets = list(listed)
    if not complete:
        # 一覧が欠けたままなので、外されたのか取りこぼしたのか分からない。前日まであった動画はIDを指定して取りに行く
        targets += gone
        gone = []
    details, failed = fetch_details(yt, targets, name)
    items = [details[vid] for vid in targets if vid in details]

    # 自動判定が確定していない動画（新規・配信前・前回タブで分からなかったもの）だけ判定し直す。全部確定済みならタブは読まない
    unfixed = [item for item in items if not known.get(item['id'], {}).get('fixed')]
    tab_types = get_tab_types(yt, channel_id) if unfixed else {}
    short_ids = [
        item['id'] for item in unfixed
        if item['id'] not in tab_types
        and item['snippet'].get('liveBroadcastContent', 'none') == 'none'
        and 0 < get_duration_seconds(item) <= SHORT_MAX_SEC
    ]
    short_cache = check_shorts_batch(short_ids) if short_ids else {}
    unfixed_ids = {item['id'] for item in unfixed}
    channel_flags = flags.get(name, {})

    videos = {}
    for item in items:
        vid = item['id']
        duration = get_duration_seconds(item)
        if vid in unfixed_ids:
            auto, fixed = classify(duration, item['snippet'].get('liveBroadcastContent', 'none'),
                                   tab_types.get(vid), short_cache.get(vid))
        else:
            cached = known[vid]
            auto, fixed = cached.get('auto', cached.get('type', 'Movie')), True
        stats = item.get('statistics', {})
        videos[vid] = {
            'タイトル': item['snippet']['title'],
            '公開日': item['snippet']['publishedAt'][:10],
            'duration': duration,
            'type': channel_flags.get(vid, auto),  # 例外設定は常に最優先。auto は例外を外したときに戻る先
            'auto': auto,
            'fixed': fixed,
            'stats': [int(stats.get('viewCount', 0)), int(stats.get('likeCount', 0)), int(stats.get('commentCount', 0))],
        }

    # グリッチ検知: 高評価・コメント数が0だが前日は0でなかった動画を取り直す
    glitch_ids = [vid for vid, v in videos.items()
                  if v['stats'][1] == 0 and v['stats'][2] == 0
                  and vid in prev_v and (prev_v[vid][1] > 0 or prev_v[vid][2] > 0)]
    if glitch_ids:
        print(f'  ⚠️  [{name}] グリッチ疑い: {len(glitch_ids)}本（高評価・コメント数が0）。5秒後に取り直します')
        time.sleep(5)
        retried, _ = fetch_details(yt, glitch_ids, name, part='statistics')
        fixed_count = 0
        for vid, item in retried.items():
            likes = int(item['statistics'].get('likeCount', 0))
            comments = int(item['statistics'].get('commentCount', 0))
            if likes > 0 or comments > 0:
                videos[vid]['stats'][1:] = [likes, comments]
                fixed_count += 1
        print(f'  [{name}] グリッチ修正: {fixed_count}/{len(glitch_ids)}本')

    counts = {}
    for v in videos.values():
        counts[v['type']] = counts.get(v['type'], 0) + 1
    print(f'  [{name}] ✓ {len(videos)}本（' + ' / '.join(f'{k}: {n}本' for k, n in sorted(counts.items()))
          + f'、うち例外設定 {sum(1 for vid in videos if vid in channel_flags)}本）')

    for vid, why in (describe_gone(yt, gone) if gone else {}).items():
        print(f'  [{name}] 一覧から外れた動画（収集をやめます）: {vid} {why} / {known.get(vid, {}).get("タイトル", "")[:40]}')
    return videos, failed, {'listed': len(listed), 'total': total, 'complete': complete, 'gone': gone}


def collect_channels(channels, uploads, catalog_videos, flags, prev_v):
    """チャンネルを並列に集め、失敗したチャンネルは少し待って1回だけ取り直す。戻り値は {名前: 結果}（取れなかったものは入らない）"""
    results = {}

    def run(targets):
        failed = []
        with ThreadPoolExecutor(max_workers=CHANNEL_WORKERS) as executor:
            futures = {executor.submit(collect_channel, ch, uploads[ch['name']], catalog_videos, flags, prev_v): ch
                       for ch in targets}
            for future in as_completed(futures):
                ch = futures[future]
                try:
                    results[ch['name']] = future.result()
                except Exception as e:
                    print(f'  ❌ [{ch["name"]}] 取得できませんでした: {e}')
                    failed.append(ch)
        return failed

    failed = run(channels)
    if failed:
        print(f'\n⚠️  {len(failed)}チャンネルが失敗。{CHANNEL_RETRY_WAIT_SEC}秒後に取り直します: {", ".join(c["name"] for c in failed)}')
        time.sleep(CHANNEL_RETRY_WAIT_SEC)
        run(failed)
    return results

# ----------------------------------------------------------------
# 台帳と土台
# ----------------------------------------------------------------

def load_catalog():
    catalog = read_json(CATALOG_FILE, None) or {}
    catalog.setdefault('channels', {})
    catalog.setdefault('videos', {})
    return catalog


def update_catalog(catalog, name, info, result, today):
    """1チャンネルの収集結果を台帳に反映する。変わったところがあれば True"""
    changed = False
    videos, _, listing = result
    entries = catalog['videos']
    for vid, v in videos.items():
        new = {'タレント': name, 'タイトル': v['タイトル'], '公開日': v['公開日'], 'duration': v['duration'],
               'type': v['type'], 'auto': v['auto'], 'fixed': v['fixed']}
        old = entries.get(vid)
        if old is None:
            new['初記録'] = today
        else:
            new['初記録'] = old.get('初記録', today)   # 一覧に戻ってきた動画は「外れた日」を外す
        if old != new:
            entries[vid] = new
            changed = True
    for vid in listing['gone']:
        if vid in entries and not entries[vid].get('外れた日'):
            entries[vid]['外れた日'] = today
            changed = True
    if info is not None and catalog['channels'].get(name) != info:
        catalog['channels'][name] = info
        changed = True
    return changed


def channel_info(item):
    return {
        'チャンネル名': item['snippet']['title'],
        'banner_url': item.get('brandingSettings', {}).get('image', {}).get('bannerExternalUrl', ''),
        'uploads': item['contentDetails']['relatedPlaylists']['uploads'],
    }


def latest_daily(before):
    """before より前で一番新しい daily（無ければ None）"""
    for back in range(1, BASE_LOOKBACK_DAYS + 1):
        data = read_json(daily_path(shift_day(before, -back)))
        if data:
            return data
    return None


def latest_views(today):
    """
    この回より前に分かっている、動画ごとの最新の再生数。
    今日まででいちばん新しい daily を土台に、それより後に取った hourly を取得時刻の順に重ねる。土台が無ければ空。
    前日の値で埋めた動画は、取った値ではないので土台に入れない（次の回で変わったものとして記録される）。
    """
    base = read_json(daily_path(today)) or latest_daily(today)
    if not base:
        return {}
    filled = set(base.get(FILL_MARK, []))
    views = {} if base.get('全体補完') else {vid: s[0] for vid, s in base['v'].items() if vid not in filled}
    base_at = base.get('at') or ''
    later = []
    day = base['date']
    while day <= today:
        for name in list_names(hourly_dir(day)):
            data = read_json(f'{hourly_dir(day)}/{name}')
            if data and (data.get('at') or '') > base_at:
                later.append(data)
        day = shift_day(day, 1)
    for data in sorted(later, key=lambda d: d['at']):
        views.update(data['v'])
    return views

# ----------------------------------------------------------------
# 0時の回・予備の回
# ----------------------------------------------------------------

def assemble_channel(daily, name, result, item, prev, catalog_videos):
    """1チャンネルぶんを daily に入れる。取れなかった動画・チャンネルは前日の値で埋めて印を付ける"""
    prev_v = prev['v'] if prev else {}
    filled = set(daily.get(FILL_MARK, []))
    ids = []
    if result is None:
        # チャンネルごと取れなかった。台帳にある動画を前日の値で埋める
        for vid, c in catalog_videos.items():
            if c.get('タレント') == name and not c.get('外れた日') and vid in prev_v:
                daily['v'][vid] = list(prev_v[vid])
                filled.add(vid)
                ids.append(vid)
        report('alerts', f'{name}: チャンネルごと取得できず、前日の値で埋めました（{len(ids)}本）')
    else:
        videos, failed, info = result
        for vid, v in videos.items():
            daily['v'][vid] = list(v['stats'])
            filled.discard(vid)
            ids.append(vid)
        carried = [vid for vid in failed if vid in prev_v]
        unknown = [vid for vid in failed if vid not in prev_v]
        for vid in carried:
            daily['v'][vid] = list(prev_v[vid])
            filled.add(vid)
            ids.append(vid)
        if carried:
            report('alerts', f'{name}: {len(carried)}本の詳細が取り切れず、前日の値で埋めました')
        if unknown:
            report('alerts', f'{name}: 初めて見る{len(unknown)}本の詳細が取れず、今日は記録していません（{", ".join(unknown)}）')
        if not info['complete']:
            report('alerts', f'{name}: 一覧が総件数より少ないままでした（{info["listed"]}/{info["total"]}本）')

    if item is not None and result is not None:
        stats = item.get('statistics', {})
        ch = {'登録者数': int(stats.get('subscriberCount', 0)), '動画数': int(stats.get('videoCount', 0))}
    else:
        ch = {k: v for k, v in ((prev or {}).get('channels', {}).get(name) or {}).items() if k in ('登録者数', '動画数')}
        ch[FILL_MARK] = True
        if result is not None:
            report('alerts', f'{name}: チャンネルの登録者数などが取れず、前日の値で埋めました')
    # 総再生数は、その日のこのチャンネルの動画の再生数の合計
    ch['総再生数'] = sum(daily['v'][vid][0] for vid in ids)
    daily['channels'][name] = ch
    if filled:
        daily[FILL_MARK] = sorted(filled)
    else:
        daily.pop(FILL_MARK, None)


def fill_missing_days(prev, today):
    """収集が動かなかった日の daily を、直前の daily の値で作る（記録に穴を作らない）。作った日の並びを返す"""
    if not prev:
        return []
    made = []
    day = shift_day(prev['date'], 1)
    while day < today:
        if not exists(daily_path(day)):
            channels = {name: {**c, FILL_MARK: True} for name, c in prev['channels'].items()}
            write_json(daily_path(day), {'date': day, 'at': None, 'channels': channels, 'v': prev['v'], '全体補完': True})
            made.append(day)
        day = shift_day(day, 1)
    if made:
        report('alerts', f'収集が動かなかった日を、直前の値で埋めました: {", ".join(made)}')
    return made


def day_totals(data, prev, catalog, flags):
    """
    その日の RK 全体の合計。(全チャンネルの総再生数の合計, 種別ごとに増えた再生数)。
    増えた再生数は、前の日にもある動画の、増えた分だけを足す（サイトの Analytics と同じ数え方）。前の日が無ければ None
    """
    total = sum(ch.get('総再生数', 0) for ch in data['channels'].values())
    if prev is None:
        return total, {t: None for t in TYPES}
    inc = {t: 0 for t in TYPES}
    for vid, x in data['v'].items():
        p = prev['v'].get(vid)
        c = catalog['videos'].get(vid)
        if p is None or c is None or x[0] <= p[0]:
            continue
        t = flags.get(c['タレント'], {}).get(vid, c['type'])
        if t in inc:
            inc[t] += x[0] - p[0]
    return total, inc


def talent_totals(data, prev, catalog, flags, names):
    """
    その日のシンガーごとの合計。{名前: (総再生数, 登録者数, 種別ごとに増えた再生数)}。数え方は day_totals と同じ。
    その日に記録が無いシンガーは総再生数・登録者数が None。その日か前の日に記録が無ければ、増えた再生数は None
    """
    inc = {name: {t: 0 for t in TYPES} for name in names}
    if prev is not None:
        for vid, x in data['v'].items():
            p = prev['v'].get(vid)
            c = catalog['videos'].get(vid)
            if p is None or c is None or x[0] <= p[0] or c['タレント'] not in inc:
                continue
            t = flags.get(c['タレント'], {}).get(vid, c['type'])
            if t in TYPES:
                inc[c['タレント']][t] += x[0] - p[0]
    out = {}
    for name in names:
        ch = data['channels'].get(name)
        ok = prev is not None and ch is not None and name in prev['channels']
        out[name] = (ch.get('総再生数') if ch else None, ch.get('登録者数') if ch else None,
                     inc[name] if ok else {t: None for t in TYPES})
    return out


def update_totals(days, catalog, flags, channels):
    """
    summary/ の日ごとの合計の、指定した日の分を入れ直す。1日ぶんは数十バイトの小さいファイルなので、書き換えてよい台帳として扱う。
      daily_totals.json     RK全体（サイトの Dashboard の「RK全体の再生数」）
      talents/{名前}.json   シンガーごと（サイトのシンガーの Analytics の推移と月別）
    """
    names = [c['name'] for c in channels]
    computed = {}
    for d in sorted(set(days)):
        data = read_json(daily_path(d))
        if data:
            prev = read_json(daily_path(shift_day(d, -1)))
            computed[d] = (day_totals(data, prev, catalog, flags), talent_totals(data, prev, catalog, flags, names))

    totals = read_json(TOTALS_FILE, None)
    if not totals:
        print(f'⚠️  {TOTALS_FILE} がありません。今回の日の分だけで作ります')
        totals = {'dates': [], 'total': [], 'inc': {t: [] for t in TYPES}}
    rows = {d: (totals['total'][i], {t: totals['inc'][t][i] for t in TYPES}) for i, d in enumerate(totals['dates'])}
    for d, (rk, _) in computed.items():
        rows[d] = rk
    dates = sorted(rows)
    write_json(TOTALS_FILE, {'dates': dates, 'total': [rows[d][0] for d in dates],
                             'inc': {t: [rows[d][1][t] for d in dates] for t in TYPES}})

    for name in names:
        rel = f'{TALENTS_DIR}/{name}.json'
        cur = read_json(rel, None) or {'dates': [], 'total': [], 'subs': [], 'inc': {t: [] for t in TYPES}}
        rows = {d: (cur['total'][i], cur['subs'][i], {t: cur['inc'][t][i] for t in TYPES}) for i, d in enumerate(cur['dates'])}
        for d, (_, per) in computed.items():
            rows[d] = per[name]
        dates = sorted(rows)
        write_json(rel, {'dates': dates, 'total': [rows[d][0] for d in dates], 'subs': [rows[d][1] for d in dates],
                         'inc': {t: [rows[d][2][t] for d in dates] for t in TYPES}})


def run_daily(now, fill=False):
    """0時の全件（fill=True のときは、今日の daily が無かったときの予備の実行）"""
    today = now.strftime('%Y-%m-%d')
    if exists(daily_path(today)):
        print(f'今日（{today}）の daily はもうあります。書き換えません')
        return None
    channels = read_json(CHANNELS_FILE, [])
    flags = read_json(FLAGS_FILE, {})
    catalog = load_catalog()
    prev = latest_daily(today)
    before = latest_views(today)   # hourly/…/00 の差分の基準（daily を書く前に求める）

    print(f'処理対象: {len(channels)}チャンネル / 台帳 {len(catalog["videos"])}本 / 前回の daily {prev["date"] if prev else "なし"}')
    yt = client()
    items = fetch_channels(yt, channels, 'statistics,snippet,brandingSettings,contentDetails')
    uploads = {c['name']: (channel_info(items[c['name']])['uploads'] if c['name'] in items
                           else catalog['channels'].get(c['name'], {}).get('uploads') or 'UU' + c['channel_id'][2:])
               for c in channels}
    results = collect_channels(channels, uploads, catalog['videos'], flags, prev['v'] if prev else {})

    daily = {'date': today, 'at': now.isoformat(timespec='seconds'), 'channels': {}, 'v': {}}
    changed = False
    for c in channels:
        name = c['name']
        assemble_channel(daily, name, results.get(name), items.get(name), prev, catalog['videos'])
        if name in results:
            changed |= update_catalog(catalog, name, channel_info(items[name]) if name in items else None, results[name], today)

    made = fill_missing_days(prev, today)
    write_json(daily_path(today), daily)
    if changed:
        write_json(CATALOG_FILE, catalog)
    update_totals(made + [today], catalog, flags, channels)
    if not fill and not exists(hourly_path(today, 0)):
        filled = set(daily.get(FILL_MARK, []))
        write_json(hourly_path(today, 0), {
            'date': today, 'hour': 0, 'at': daily['at'],
            '登録者数': {name: ch['登録者数'] for name, ch in daily['channels'].items() if not ch.get(FILL_MARK)},
            'v': {vid: s[0] for vid, s in daily['v'].items() if vid not in filled and before.get(vid) != s[0]},
            **({'取得失敗': sorted(filled)} if filled else {}),
        })
    print(f'\n✓ daily: {len(daily["v"])}本 / {len(daily["channels"])}チャンネル'
          + (f'（前日の値で埋めた {len(daily.get(FILL_MARK, []))}本）' if daily.get(FILL_MARK) else ''))
    return daily


def run_fill(now):
    """予備の実行（1:00）。今日の daily が無ければ全件を取る。前日の値で埋めた分があれば、そのチャンネルを取り直す"""
    today = now.strftime('%Y-%m-%d')
    daily = read_json(daily_path(today))
    if not daily:
        print(f'今日（{today}）の daily が無いため、全件を取ります')
        run_daily(now, fill=True)
        if not REPORT['alerts']:
            report('resolved', '0時に取れなかった今日の記録を取りました')
        return

    channels = read_json(CHANNELS_FILE, [])
    catalog = load_catalog()
    filled = set(daily.get(FILL_MARK, []))
    redo_whole = {c['name'] for c in channels
                  if c['name'] not in daily['channels'] or daily['channels'][c['name']].get(FILL_MARK)}
    redo = redo_whole | {catalog['videos'][vid]['タレント'] for vid in filled if vid in catalog['videos']}
    if not redo:
        print(f'今日（{today}）の記録は揃っています。予備の実行では何もしません')
        return

    targets = [c for c in channels if c['name'] in redo]
    print(f'取り直すチャンネル: {", ".join(c["name"] for c in targets)}')
    flags = read_json(FLAGS_FILE, {})
    prev = latest_daily(today)
    yt = client()
    items = fetch_channels(yt, targets, 'statistics,snippet,brandingSettings,contentDetails')
    uploads = {c['name']: (channel_info(items[c['name']])['uploads'] if c['name'] in items
                           else catalog['channels'].get(c['name'], {}).get('uploads') or 'UU' + c['channel_id'][2:])
               for c in targets}
    results = collect_channels(targets, uploads, catalog['videos'], flags, prev['v'] if prev else {})

    changed = False
    for c in targets:
        name = c['name']
        result = results.get(name)
        if name in redo_whole:
            # チャンネルごと埋めていた: 取れたら、このチャンネルの分をまるごと入れ直す
            if result is None:
                report('alerts', f'{name}: 予備の実行でもチャンネルごと取得できず、前日の値で埋めたままです')
                continue
            mine = {vid for vid, cv in catalog['videos'].items() if cv.get('タレント') == name}
            for vid in mine:
                daily['v'].pop(vid, None)
            daily[FILL_MARK] = sorted(set(daily.get(FILL_MARK, [])) - mine)
            alerts_before = len(REPORT['alerts'])
            assemble_channel(daily, name, result, items.get(name), prev, catalog['videos'])
            changed |= update_catalog(catalog, name, channel_info(items[name]) if name in items else None, result, today)
            if len(REPORT['alerts']) == alerts_before:
                report('resolved', f'{name}: 0時に取れなかった今日の記録を取りました')
        else:
            # 一部の動画だけ埋めていた: 実際の値が取れた動画だけ差し替える
            mine = {vid for vid in filled if catalog['videos'].get(vid, {}).get('タレント') == name}
            got = {vid: v for vid, v in (result[0] if result else {}).items() if vid in mine}
            for vid, v in got.items():
                daily['v'][vid] = list(v['stats'])
            daily[FILL_MARK] = sorted(set(daily.get(FILL_MARK, [])) - set(got))
            ids = [vid for vid, cv in catalog['videos'].items() if cv.get('タレント') == name and vid in daily['v']]
            daily['channels'][name]['総再生数'] = sum(daily['v'][vid][0] for vid in ids)
            if got:
                report('resolved', f'{name}: 0時に前日の値で埋めた{len(got)}本を、実際の値に差し替えました')
            if mine - set(got):
                report('alerts', f'{name}: {len(mine - set(got))}本は予備の実行でも取れず、前日の値で埋めたままです')

    if not daily.get(FILL_MARK):
        daily.pop(FILL_MARK, None)
    daily['取り直し'] = now.isoformat(timespec='seconds')
    write_json(daily_path(today), daily)
    if changed:
        write_json(CATALOG_FILE, catalog)
    update_totals([today], catalog, flags, channels)

# ----------------------------------------------------------------
# 毎時の回
# ----------------------------------------------------------------

def run_hourly(now):
    """全動画の再生数と登録者数を取り、前の回から再生数が変わった動画だけを書く。失敗した時間は埋めない"""
    today = now.strftime('%Y-%m-%d')
    rel = hourly_path(today, now.hour)
    if exists(rel):
        print(f'{rel} はもうあります。書き換えません')
        return None
    catalog = read_json(CATALOG_FILE, None)
    if not catalog or not catalog.get('videos'):
        print('台帳（catalog.json）がまだありません。0時の回で作られるまで待ちます')
        return None
    channels = read_json(CHANNELS_FILE, [])
    known = catalog['videos']

    yt = client()
    items = fetch_channels(yt, channels, 'statistics')
    subs = {c['name']: int(items[c['name']]['statistics'].get('subscriberCount', 0)) for c in channels if c['name'] in items}

    # 新着: 各チャンネルの一覧の最初の1ページ（新しい50本）。台帳には次の0時に入る
    new_ids = []
    for c in channels:
        uploads = catalog['channels'].get(c['name'], {}).get('uploads') or 'UU' + c['channel_id'][2:]
        try:
            resp = execute_with_retry(yt.playlistItems().list(part='contentDetails', playlistId=uploads, maxResults=50))
            new_ids += [item['contentDetails']['videoId'] for item in resp.get('items', [])
                        if item['contentDetails']['videoId'] not in known]
        except Exception as e:
            print(f'  ⚠️  [{c["name"]}] 新着の確認に失敗しました: {e}')
    new_ids = list(dict.fromkeys(new_ids))

    targets = [vid for vid, c in known.items() if not c.get('外れた日')] + new_ids
    got, missing = fetch_details(yt, targets, '毎時', part='statistics')
    before = latest_views(today)
    views = {vid: int(got[vid]['statistics'].get('viewCount', 0)) for vid in targets if vid in got}
    data = {
        'date': today, 'hour': now.hour, 'at': now.isoformat(timespec='seconds'),
        '登録者数': subs,
        'v': {vid: n for vid, n in views.items() if before.get(vid) != n},
    }
    if missing:
        data['取得失敗'] = missing
    if new_ids:
        data['新着'] = new_ids
    write_json(rel, data)
    print(f'\n✓ hourly {today} {now.hour:02d}時: 取れた {len(views)}/{len(targets)}本、変わった {len(data["v"])}本、'
          f'登録者数 {len(subs)}/{len(channels)}チャンネル、新着 {len(new_ids)}本')
    return data

# ----------------------------------------------------------------
# 通知
# ----------------------------------------------------------------

def notify(today, fill, title=None):
    """
    取り切れなかった分があれば、GitHub の Issue で知らせる（同じ日の Issue があれば追記する）。
    予備の実行で解消したときは、その日の Issue に書き添えて閉じる。GitHub Actions の上でだけ動く。
    """
    alerts, resolved = REPORT['alerts'], REPORT['resolved']
    for line in alerts:
        print(f'⚠️  {line}')
    token = os.environ.get('GITHUB_TOKEN')
    repo = os.environ.get('GITHUB_REPOSITORY')
    if not token or not repo or not (alerts or resolved):
        return
    title = title or f'データ収集の欠け {today}'
    run_url = f'{os.environ.get("GITHUB_SERVER_URL", "https://github.com")}/{repo}/actions/runs/{os.environ.get("GITHUB_RUN_ID", "")}'
    when = '予備の実行（1:00）' if fill else '定時の実行（0:00）'
    api = f'https://api.github.com/repos/{repo}/issues'
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'}
    try:
        found = requests.get(api, params={'state': 'open', 'per_page': 100}, headers=headers, timeout=20).json()
        number = next((i['number'] for i in found if i.get('title') == title and 'pull_request' not in i), None)
        if alerts:
            body = (f'{when}で、取り切れなかった分があります。\n\n' + '\n'.join(f'- {a}' for a in alerts)
                    + (('\n\n解消した分:\n' + '\n'.join(f'- {r}' for r in resolved)) if resolved else '')
                    + f'\n\n実行の記録: {run_url}')
            if number:
                requests.post(f'{api}/{number}/comments', json={'body': body}, headers=headers, timeout=20).raise_for_status()
            else:
                requests.post(api, json={'title': title, 'body': body}, headers=headers, timeout=20).raise_for_status()
            print(f'  通知しました（Issue「{title}」）')
        elif number:
            body = f'{when}で取り直し、解消しました。\n\n' + '\n'.join(f'- {r}' for r in resolved) + f'\n\n実行の記録: {run_url}'
            requests.post(f'{api}/{number}/comments', json={'body': body}, headers=headers, timeout=20).raise_for_status()
            requests.patch(f'{api}/{number}', json={'state': 'closed'}, headers=headers, timeout=20).raise_for_status()
            print(f'  解消したため Issue「{title}」を閉じました')
    except Exception as e:
        print(f'⚠️  通知に失敗しました: {e}')

# ----------------------------------------------------------------
# メイン
# ----------------------------------------------------------------

def main(mode, now=None):
    now = now or datetime.now(JST)
    if mode == 'auto':
        mode = 'daily' if now.hour == 0 else 'hourly'
    print('=' * 50)
    print(f'RKMusic_Ledger 収集（{mode}） {now.strftime("%Y-%m-%d %H:%M:%S")}')
    print('=' * 50)

    if mode == 'alert-test':
        report('alerts', 'これは通知のテストです。データには触れていません。確認できたらこの Issue は閉じてください')
        notify(now.strftime('%Y-%m-%d'), False, title='データ収集の欠け（通知のテスト）')
        return
    if not API_KEY:
        print('❌ YOUTUBE_API_KEY が設定されていません')
        sys.exit(1)

    today = now.strftime('%Y-%m-%d')
    if mode == 'daily':
        run_daily(now)
        notify(today, False)
    elif mode == 'fill':
        run_fill(now)
        notify(today, True)
    elif mode == 'hourly':
        run_hourly(now)
    elif mode == 'test':
        run_daily(now)
        run_hourly(now)
        for line in REPORT['alerts']:
            print(f'⚠️  {line}')
    print('\nAPI の呼び出し（1回1ユニット）: ' + ' / '.join(f'{k} {n}' for k, n in sorted(CALLS.items()))
          + f' / 合計 {sum(CALLS.values())}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', default='auto', choices=['auto', 'daily', 'hourly', 'fill', 'test', 'alert-test'])
    main(parser.parse_args().mode)
