#!/bin/bash
# Pre-commit hook: блокирует случайный коммит секретов.
#
# Канонический шаблон. Копия в <repo>/.githooks/pre-commit для каждого репо.
# Расширение паттернов — править здесь, потом распространить копированием.
#
# Покрывает:
#   - Better Stack API token: ust_<≥20 alnum>
#   - Telegram bot token:     <8-10 digits>:<35 alnum/_/->
#   - Hex secret (≥32) присвоенный в *_SECRET / *_HMAC / *_TOKEN / *_API_KEY
#   - Neon API key:           napi_<≥30 alnum>
#   - DATABASE_URL с user:pass: postgresql(ql)?://user:pass@...
#   - Anthropic API key:      sk-ant-api<NN>-<chars>
#   - GitHub token:           ghp_/gho_/ghs_/ghr_/ghu_ + alnum
#   - AWS access key:         AKIA + 16 alphanum
#   - Generic 40-char API token в *_API_KEY/*_TOKEN присвоении
#
# Активация: git config core.hooksPath .githooks
# Bypass:    git commit --no-verify  (только осознанно)

staged_diff=$(git diff --cached --diff-filter=ACM)
if [ -z "$staged_diff" ]; then
    exit 0
fi

added_lines=$(echo "$staged_diff" | grep -E '^\+' | grep -vE '^\+\+\+ ')

violations=""

check_pattern() {
    local label="$1"
    local pattern="$2"
    local hits
    hits=$(echo "$added_lines" | grep -nE "$pattern" || true)
    if [ -n "$hits" ]; then
        violations="${violations}
[$label]
$hits
"
    fi
}

check_pattern "Better Stack API token"          'ust_[A-Za-z0-9]{20,}'
check_pattern "Telegram bot token"              '[0-9]{8,10}:[A-Za-z0-9_-]{35}'
check_pattern "Hex secret в env-присваивании"   '(_SECRET|_HMAC|_TOKEN|_API_KEY)[[:space:]]*=[[:space:]]*"?[a-f0-9]{32,}'
check_pattern "Neon API key"                    'napi_[A-Za-z0-9]{30,}'
check_pattern "DATABASE_URL с user:pass"        'postgresql(ql)?://[^:[:space:]]+:[^@[:space:]]{4,}@'
check_pattern "Anthropic API key"               'sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{30,}'
check_pattern "GitHub token"                    'gh[poshru]_[A-Za-z0-9]{30,}'
check_pattern "AWS access key"                  'AKIA[0-9A-Z]{16}'
check_pattern "Generic 40+ char API token"      '(_API_KEY|_TOKEN|_KEY)[[:space:]]*=[[:space:]]*"?[A-Za-z0-9_-]{40,}"?'

if [ -n "$violations" ]; then
    echo ""
    echo "🚫 Pre-commit BLOCKED: возможный секрет в staged изменениях."
    echo "$violations"
    echo "Если это плейсхолдер/тест — отрегулируй паттерн в .githooks/pre-commit"
    echo "Канонический шаблон: ~/IWE/scripts/pre-commit-secret-scan.sh"
    echo "Bypass (осознанно): git commit --no-verify"
    echo ""
    exit 1
fi

exit 0
