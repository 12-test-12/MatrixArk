-- Update TopicAiSetting provider check constraint to support local and cloud providers
ALTER TABLE "TopicAiSetting" DROP CONSTRAINT IF EXISTS "TopicAiSetting_provider_check";
ALTER TABLE "TopicAiSetting" ADD CONSTRAINT "TopicAiSetting_provider_check" 
    CHECK ("provider" IN ('ollama', 'lmstudio', 'custom', 'deepseek', 'qwen', 'zhipu', 'moonshot', 'siliconflow', 'openai'));
