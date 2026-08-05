-- Broaden the music bucket's allowed mime types so the dashboard's
-- soundtrack uploader can accept common audio formats beyond mp3/wav/aac.
update storage.buckets
set allowed_mime_types = array[
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'audio/mp4',
  'audio/x-m4a',
  'audio/ogg',
  'audio/flac',
  'audio/webm'
]
where id = 'music';
