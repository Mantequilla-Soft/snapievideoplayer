#!/bin/bash
# Pre-deployment safety check

echo "🔍 Running pre-deployment safety check..."
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ ERROR: .env file not found!"
    echo "   Copy .env.example to .env and configure it"
    exit 1
fi

# Check if .env is in gitignore
if grep -q "^\.env$" .gitignore; then
    echo "✅ .env is in .gitignore"
else
    echo "⚠️  WARNING: .env not found in .gitignore"
fi

# Check if node_modules is in gitignore
if grep -q "node_modules" .gitignore; then
    echo "✅ node_modules is in .gitignore"
else
    echo "⚠️  WARNING: node_modules not in .gitignore"
fi

# Check for hardcoded credentials in tracked files
echo ""
echo "🔍 Checking for potential credential leaks..."
if git ls-files | xargs grep -l "mongodb://.*:.*@" 2>/dev/null; then
    echo "❌ ERROR: Found hardcoded MongoDB credentials in tracked files!"
    exit 1
else
    echo "✅ No hardcoded credentials found in tracked files"
fi

# Check if dist is built
if [ ! -d "dist" ]; then
    echo "⚠️  WARNING: dist/ folder not found. Run 'npm run build' first"
else
    echo "✅ dist/ folder exists"
fi

echo ""
echo "✅ Safety check passed! Safe to commit and push."
echo ""
echo "Next steps:"
echo "  git add ."
echo "  git commit -m 'Initial commit: 3speak video player'"
echo "  git remote add origin <your-repo-url>"
echo "  git push -u origin master"
