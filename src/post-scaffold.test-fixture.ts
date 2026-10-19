// Test snapshot only. The production source is scripts/_publish_convention.json in the managed index repo.
export const POST_CONVENTION_FIXTURE = {
  "version": 1,
  "reverse_month_base": 13,
  "months_ru": [
    "январь",
    "февраль",
    "март",
    "апрель",
    "май",
    "июнь",
    "июль",
    "август",
    "сентябрь",
    "октябрь",
    "ноябрь",
    "декабрь"
  ],
  "channels": {
    "club": 1,
    "facebook": 2,
    "linkedin": 3,
    "telegram": 4,
    "tenchat": 5,
    "x": 6,
    "youtube": 7,
    "dzen": 8
  },
  "patterns": {
    "slug": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    "month_dir": "^([0-9]{2})-(.+)$",
    "new_post_prefix": "^([0-9]{2})-([0-9]{2})-[0-9]{4}-[0-9]{2}-[0-9]{2}-",
    "new_post": "^[0-9]{2}-[0-9]{2}-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+$",
    "legacy_post": "^[0-9]{3}-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+$",
    "legacy_alt_post": "^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{3}-[a-z0-9-]+$",
    "service": "^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+(?:\\.md)?$"
  },
  "non_month_dirs": [
    "images"
  ],
  "templates": {
    "month_dir": "{reverse_month}-{month_name}",
    "post_dir": "{sequence}-{month}-{date}-{slug}",
    "channel_file": "{sequence}-{month}-{channel_number}-{channel}-{date}.md"
  }
};
