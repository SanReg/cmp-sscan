Create a simple express web app with tailwind css for html part, what it does it, it has a button which could be toogled to on or off, when off it doesn't nothing, when the button is toggled on, it looks for incoming orders at db in .env, after an order comes, it checks file url inside userFile, and posts it to other thirdparty api site, when the order is complete it uploads those ai and similarity reports file to Cloudinary and their respective link to adminFiles url for both similarity and ai marks completed and incase of failure it marks failed with respective error in failureReason

# 1. Check quota
curl -s -H "Authorization: Bearer $TOKEN" \
  https://nwlguwssyxjpjddolsvl.supabase.co/functions/v1/api-account | jq .

# 2. Upload document
ORDER_ID=$(curl -s -X POST https://nwlguwssyxjpjddolsvl.supabase.co/functions/v1/api-documents \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./document.docx" \
  -F "excludeQuotes=true" \
  | jq -r .orderId)
echo "ORDER_ID=$ORDER_ID"

# 3. Poll until terminal state
while true; do
  S=$(curl -s -H "Authorization: Bearer $TOKEN" \
       "https://nwlguwssyxjpjddolsvl.supabase.co/functions/v1/api-document-get?id=$ORDER_ID" | jq -r .status)
  echo "$(date +%T) status=$S"
  [[ "$S" == "completed" || "$S" == "error" || "$S" == "failed_invalid" ]] && break
  sleep 5
done

# 4. Download reports
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://nwlguwssyxjpjddolsvl.supabase.co/functions/v1/api-document-get?id=$ORDER_ID" \
  | jq -r .reports.similarity.downloadUrl \
  | xargs curl -L -o similarity.pdf

curl -s -H "Authorization: Bearer $TOKEN" \
  "https://nwlguwssyxjpjddolsvl.supabase.co/functions/v1/api-document-get?id=$ORDER_ID" \
  | jq -r .reports.ai.downloadUrl \
  | xargs curl -L -o ai.pdf

All respective secrets are in .env file access it


It should only look for the incoming orders after the toggled is on, not the previous pending orders
for the failure, it should refund the same type credit used, which regular, expiry or sth make that work too
