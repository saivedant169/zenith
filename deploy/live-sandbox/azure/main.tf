terraform {
  required_version = ">= 1.6.0"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = ">= 5.7.0, < 6.0.0" }
  }
}

# Owner-operated bootstrap only. The harness never invokes init/plan/apply.
provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
  use_oidc        = true
}
variable "subscription_id" { type = string }
# The Azure for Students subscription only allows these regions: polandcentral, eastasia, austriaeast, indiasouthcentral, koreacentral.
# The owner confirmed eastasia for this sandbox (2026-10-25); any other region is refused by the subscription policy.
variable "region" { type = string }
variable "name" { type = string }
variable "github_repository" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "Use the exact approved owner/repository."
  }
}
variable "github_oidc_subject_prefix" {
  description = "Subject prefix GitHub puts in this repository's OIDC tokens, or empty for repo:<github_repository>. Repositories using immutable subjects send repo:<owner>@<owner_id>/<name>@<repo_id> (gh api repos/<owner>/<name>/actions/oidc/customization/sub)."
  type        = string
  default     = ""
  validation {
    condition     = var.github_oidc_subject_prefix == "" || can(regex("^repo:[A-Za-z0-9-]+(@[0-9]+)?/[A-Za-z0-9._-]+(@[0-9]+)?$", var.github_oidc_subject_prefix))
    error_message = "Subject prefix must be repo:owner/name, optionally with @id suffixes."
  }
}
variable "owner_tag" {
  description = "Value of the zenith_owner resource group tag."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9._-]{1,64}$", var.owner_tag))
    error_message = "Owner tag must be 1-64 characters of letters, digits, dot, underscore or hyphen."
  }
}
variable "github_environment" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]+$", var.github_environment))
    error_message = "Use an exact protected GitHub environment."
  }
}
variable "budget_usd" {
  type = number
  validation {
    condition     = var.budget_usd > 0 && var.budget_usd <= 100
    error_message = "Sandbox monthly alert budget must be positive and at most USD 100."
  }
}
variable "budget_start" { type = string }
variable "budget_end" { type = string }
variable "alert_email" { type = string }

resource "azurerm_resource_group" "sandbox" {
  name     = var.name
  location = var.region
  tags     = { zenith_sandbox = "true", zenith_owner = var.owner_tag }
}
resource "azurerm_user_assigned_identity" "observer" {
  name                = "${var.name}-observer"
  location            = var.region
  resource_group_name = azurerm_resource_group.sandbox.name
  tags                = azurerm_resource_group.sandbox.tags
}
resource "azurerm_federated_identity_credential" "github" {
  name                      = "github-protected-environment"
  user_assigned_identity_id = azurerm_user_assigned_identity.observer.id
  issuer                    = "https://token.actions.githubusercontent.com"
  audience                  = ["api://AzureADTokenExchange"]
  subject                   = "${var.github_oidc_subject_prefix != "" ? var.github_oidc_subject_prefix : "repo:${var.github_repository}"}:environment:${var.github_environment}"
}
resource "azurerm_role_definition" "observer" {
  name              = "${var.name}-acceptance-readback"
  scope             = azurerm_resource_group.sandbox.id
  assignable_scopes = [azurerm_resource_group.sandbox.id]
  permissions {
    actions = [
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Resources/subscriptions/resourceGroups/resources/read",
      "Microsoft.Authorization/roleAssignments/read",
      "Microsoft.Authorization/roleDefinitions/read",
      "Microsoft.Network/dnsZones/read",
      "Microsoft.Network/dnsZones/recordsets/read",
      "Microsoft.ContainerRegistry/registries/read",
      "Microsoft.ContainerRegistry/registries/runs/read",
      "Microsoft.Storage/storageAccounts/read",
      "Microsoft.KeyVault/vaults/read"
    ]
    not_actions = []
  }
}
resource "azurerm_role_assignment" "observer" {
  scope              = azurerm_resource_group.sandbox.id
  role_definition_id = azurerm_role_definition.observer.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.observer.principal_id
}
# Data-plane access is separately scoped to existing owned fixtures, never subscription-wide.
variable "blob_container_scope" { type = string }
variable "key_vault_scope" { type = string }
variable "registry_scope" { type = string }
resource "azurerm_role_assignment" "blob" {
  scope                = var.blob_container_scope
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_user_assigned_identity.observer.principal_id
}
resource "azurerm_role_assignment" "vault" {
  scope                = var.key_vault_scope
  role_definition_name = "Key Vault Reader"
  principal_id         = azurerm_user_assigned_identity.observer.principal_id
}
resource "azurerm_role_assignment" "registry" {
  scope                = var.registry_scope
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.observer.principal_id
}
resource "azurerm_consumption_budget_resource_group" "sandbox" {
  name              = "${var.name}-budget"
  resource_group_id = azurerm_resource_group.sandbox.id
  amount            = var.budget_usd
  time_grain        = "Monthly"
  time_period {
    start_date = var.budget_start
    end_date   = var.budget_end
  }
  notification {
    enabled        = true
    threshold      = 50
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_emails = [var.alert_email]
  }
  notification {
    enabled        = true
    threshold      = 80
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Forecasted"
    contact_emails = [var.alert_email]
  }
}
output "client_id" { value = azurerm_user_assigned_identity.observer.client_id }
output "resource_group_scope" { value = azurerm_resource_group.sandbox.id }
output "retained_resource_ids" {
  value = [azurerm_user_assigned_identity.observer.id, azurerm_federated_identity_credential.github.id]
}
