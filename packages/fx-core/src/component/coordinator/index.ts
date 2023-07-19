// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { DotenvParseOutput } from "dotenv";
import fs from "fs-extra";
import * as jsonschema from "jsonschema";
import { camelCase, merge } from "lodash";
import { EOL } from "os";
import * as path from "path";
import * as uuid from "uuid";
import * as xml2js from "xml2js";

import { hooks } from "@feathersjs/hooks/lib";
import {
  Colors,
  Context,
  err,
  FxError,
  Inputs,
  InputsWithProjectPath,
  ok,
  Platform,
  Result,
  Void,
} from "@microsoft/teamsfx-api";
import { glob } from "glob";
import { getLocalizedString } from "../../common/localizeUtils";
import { TelemetryEvent, TelemetryProperty } from "../../common/telemetry";
import { getResourceGroupInPortal } from "../../common/tools";
import { MetadataV3 } from "../../common/versionMetadata";
import { ObjectIsUndefinedError } from "../../core/error";
import { globalVars } from "../../core/globalVars";
import { ResourceGroupConflictError, SelectSubscriptionError } from "../../error/azure";
import {
  assembleError,
  InputValidationError,
  MissingEnvironmentVariablesError,
  MissingRequiredInputError,
} from "../../error/common";
import { LifeCycleUndefinedError } from "../../error/yml";
import {
  AppNamePattern,
  CapabilityOptions,
  NotificationTriggerOptions,
  ProjectTypeOptions,
  ScratchOptions,
} from "../../question/create";
import { QuestionNames } from "../../question/questionNames";
import { ExecutionError, ExecutionOutput, ILifecycle } from "../configManager/interface";
import { Lifecycle } from "../configManager/lifecycle";
import { CoordinatorSource } from "../constants";
import { deployUtils } from "../deployUtils";
import { developerPortalScaffoldUtils } from "../developerPortalScaffoldUtils";
import { DriverContext } from "../driver/interface/commonArgs";
import { updateTeamsAppV3ForPublish } from "../driver/teamsApp/appStudio";
import { AppStudioScopes, Constants } from "../driver/teamsApp/constants";
import { Generator } from "../generator/generator";
import { OfficeAddinGenerator } from "../generator/officeAddin/generator";
import { SPFxGenerator } from "../generator/spfx/spfxGenerator";
import { convertToLangKey } from "../generator/utils";
import { ActionContext, ActionExecutionMW } from "../middleware/actionExecutionMW";
import { provisionUtils } from "../provisionUtils";
import { envUtil } from "../utils/envUtil";
import { metadataUtil } from "../utils/metadataUtil";
import { pathUtils } from "../utils/pathUtils";
import { resourceGroupHelper, ResourceGroupInfo } from "../utils/ResourceGroupHelper";
import { settingsUtil } from "../utils/settingsUtil";
import { SummaryReporter } from "./summary";
import { CopilotPluginGenerator } from "../generator/copilotPlugin/generator";

export enum TemplateNames {
  Tab = "non-sso-tab",
  SsoTab = "sso-tab",
  M365Tab = "m365-tab",
  DashboardTab = "dashboard-tab",
  NotificationRestify = "notification-restify",
  NotificationWebApi = "notification-webapi",
  NotificationHttpTrigger = "notification-http-trigger",
  NotificationTimerTrigger = "notification-timer-trigger",
  NotificationHttpTimerTrigger = "notification-http-timer-trigger",
  CommandAndResponse = "command-and-response",
  Workflow = "workflow",
  DefaultBot = "default-bot",
  MessageExtension = "message-extension",
  M365MessageExtension = "m365-message-extension",
  TabAndDefaultBot = "non-sso-tab-default-bot",
  BotAndMessageExtension = "default-bot-message-extension",
  SsoTabObo = "sso-tab-with-obo-flow",
  LinkUnfurling = "link-unfurling",
}

const Feature2TemplateName: any = {
  [`${CapabilityOptions.notificationBot().id}:${NotificationTriggerOptions.appService().id}`]:
    TemplateNames.NotificationRestify,
  [`${CapabilityOptions.notificationBot().id}:${NotificationTriggerOptions.appServiceForVS().id}`]:
    TemplateNames.NotificationWebApi,
  [`${CapabilityOptions.notificationBot().id}:${
    NotificationTriggerOptions.functionsHttpTrigger().id
  }`]: TemplateNames.NotificationHttpTrigger,
  [`${CapabilityOptions.notificationBot().id}:${
    NotificationTriggerOptions.functionsTimerTrigger().id
  }`]: TemplateNames.NotificationTimerTrigger,
  [`${CapabilityOptions.notificationBot().id}:${
    NotificationTriggerOptions.functionsHttpAndTimerTrigger().id
  }`]: TemplateNames.NotificationHttpTimerTrigger,
  [`${CapabilityOptions.commandBot().id}:undefined`]: TemplateNames.CommandAndResponse,
  [`${CapabilityOptions.workflowBot().id}:undefined`]: TemplateNames.Workflow,
  [`${CapabilityOptions.basicBot().id}:undefined`]: TemplateNames.DefaultBot,
  [`${CapabilityOptions.me().id}:undefined`]: TemplateNames.MessageExtension,
  [`${CapabilityOptions.m365SearchMe().id}:undefined`]: TemplateNames.M365MessageExtension,
  [`${CapabilityOptions.tab().id}:undefined`]: TemplateNames.SsoTab,
  [`${CapabilityOptions.nonSsoTab().id}:undefined`]: TemplateNames.Tab,
  [`${CapabilityOptions.m365SsoLaunchPage().id}:undefined`]: TemplateNames.SsoTabObo,
  [`${CapabilityOptions.dashboardTab().id}:undefined`]: TemplateNames.DashboardTab,
  [`${CapabilityOptions.nonSsoTabAndBot().id}:undefined`]: TemplateNames.TabAndDefaultBot,
  [`${CapabilityOptions.botAndMe().id}:undefined`]: TemplateNames.BotAndMessageExtension,
  [`${CapabilityOptions.linkUnfurling().id}:undefined`]: TemplateNames.LinkUnfurling,
};

const M365Actions = [
  "botAadApp/create",
  "teamsApp/create",
  "teamsApp/update",
  "aadApp/create",
  "aadApp/update",
  "botFramework/create",
  "teamsApp/extendToM365",
];
const AzureActions = ["arm/deploy"];
const AzureDeployActions = [
  "azureAppService/zipDeploy",
  "azureFunctions/zipDeploy",
  "azureStorage/deploy",
];
const needTenantCheckActions = ["botAadApp/create", "aadApp/create", "botFramework/create"];

class Coordinator {
  @hooks([
    ActionExecutionMW({
      enableTelemetry: true,
      telemetryEventName: TelemetryEvent.CreateProject,
      telemetryComponentName: "coordinator",
      errorSource: CoordinatorSource,
    }),
  ])
  async create(
    context: Context,
    inputs: Inputs,
    actionContext?: ActionContext
  ): Promise<Result<string, FxError>> {
    const folder = inputs["folder"] as string;
    if (!folder) {
      return err(new MissingRequiredInputError("folder"));
    }
    const scratch = inputs[QuestionNames.Scratch] as string;
    let projectPath = "";
    if (scratch === ScratchOptions.no().id) {
      // create from sample
      const sampleId = inputs[QuestionNames.Samples] as string;
      if (!sampleId) {
        throw new MissingRequiredInputError(QuestionNames.Samples);
      }
      projectPath = path.join(folder, sampleId);
      let suffix = 1;
      while ((await fs.pathExists(projectPath)) && (await fs.readdir(projectPath)).length > 0) {
        projectPath = path.join(folder, `${sampleId}_${suffix++}`);
      }

      inputs.projectPath = projectPath;
      await fs.ensureDir(projectPath);

      const res = await Generator.generateSample(context, projectPath, sampleId);
      if (res.isErr()) return err(res.error);

      await downloadSampleHook(sampleId, projectPath);
    } else if (!scratch || scratch === ScratchOptions.yes().id) {
      // create from new
      const appName = inputs[QuestionNames.AppName] as string;
      if (undefined === appName) return err(new MissingRequiredInputError(QuestionNames.AppName));
      const validateResult = jsonschema.validate(appName, {
        pattern: AppNamePattern,
      });
      if (validateResult.errors && validateResult.errors.length > 0) {
        return err(
          new InputValidationError(QuestionNames.AppName, validateResult.errors[0].message)
        );
      }
      projectPath = path.join(folder, appName);
      inputs.projectPath = projectPath;

      await fs.ensureDir(projectPath);

      // set isVS global var when creating project
      const language = inputs[QuestionNames.ProgrammingLanguage];
      globalVars.isVS = language === "csharp";
      const capability = inputs.capabilities as string;
      delete inputs.folder;

      merge(actionContext?.telemetryProps, {
        [TelemetryProperty.Capabilities]: capability,
        [TelemetryProperty.IsFromTdp]: (!!inputs.teamsAppFromTdp).toString(),
      });

      if (capability === CapabilityOptions.SPFxTab().id) {
        const res = await SPFxGenerator.generate(context, inputs, projectPath);
        if (res.isErr()) return err(res.error);
      } else if (inputs[QuestionNames.ProjectType] === ProjectTypeOptions.outlookAddin().id) {
        const res = await OfficeAddinGenerator.generate(context, inputs, projectPath);
        if (res.isErr()) {
          return err(res.error);
        }
      } else if (
        inputs[QuestionNames.Capabilities] === CapabilityOptions.copilotPluginApiSpec().id ||
        inputs[QuestionNames.Capabilities] === CapabilityOptions.copilotPluginOpenAIPlugin().id
      ) {
        const res = await CopilotPluginGenerator.generate(context, inputs, projectPath);
        if (res.isErr()) {
          return err(res.error);
        }
      } else {
        if (
          capability === CapabilityOptions.m365SsoLaunchPage().id ||
          capability === CapabilityOptions.m365SearchMe().id
        ) {
          inputs.isM365 = true;
        }
        const trigger = inputs[QuestionNames.BotTrigger] as string;
        const templateName = Feature2TemplateName[`${capability}:${trigger}`];
        if (templateName) {
          const langKey = convertToLangKey(language);
          const safeProjectNameFromVS =
            language === "csharp" ? inputs[QuestionNames.SafeProjectName] : undefined;
          context.templateVariables = Generator.getDefaultVariables(appName, safeProjectNameFromVS);
          const res = await Generator.generateTemplate(context, projectPath, templateName, langKey);
          if (res.isErr()) return err(res.error);
        }
      }
    }

    // generate unique projectId in teamsapp.yaml (optional)
    const ymlPath = path.join(projectPath, MetadataV3.configFile);
    if (fs.pathExistsSync(ymlPath)) {
      const ensureRes = await this.ensureTrackingId(projectPath, inputs.projectId);
      if (ensureRes.isErr()) return err(ensureRes.error);
      inputs.projectId = ensureRes.value;
    }

    context.projectPath = projectPath;

    if (inputs.teamsAppFromTdp) {
      const res = await developerPortalScaffoldUtils.updateFilesForTdp(
        context,
        inputs.teamsAppFromTdp,
        inputs
      );
      if (res.isErr()) {
        return err(res.error);
      }
    }
    return ok(projectPath);
  }

  async ensureTeamsFxInCsproj(projectPath: string): Promise<Result<undefined, FxError>> {
    const list = await fs.readdir(projectPath);
    const csprojFiles = list.filter((fileName) => fileName.endsWith(".csproj"));
    if (csprojFiles.length === 0) return ok(undefined);
    const filePath = csprojFiles[0];
    const xmlStringOld = (await fs.readFile(filePath, { encoding: "utf8" })).toString();
    const jsonObj = await xml2js.parseStringPromise(xmlStringOld);
    let ItemGroup = jsonObj.Project.ItemGroup;
    if (!ItemGroup) {
      ItemGroup = [];
      jsonObj.Project.ItemGroup = ItemGroup;
    }
    const existItems = ItemGroup.filter((item: any) => {
      if (item.ProjectCapability && item.ProjectCapability[0])
        if (item.ProjectCapability[0]["$"]?.Include === "TeamsFx") return true;
      return false;
    });
    if (existItems.length === 0) {
      const toAdd = {
        ProjectCapability: [
          {
            $: {
              Include: "TeamsFx",
            },
          },
        ],
      };
      ItemGroup.push(toAdd);
      const builder = new xml2js.Builder();
      const xmlStringNew = builder.buildObject(jsonObj);
      await fs.writeFile(filePath, xmlStringNew, { encoding: "utf8" });
    }
    return ok(undefined);
  }

  async ensureTrackingId(
    projectPath: string,
    trackingId: string | undefined = undefined
  ): Promise<Result<string, FxError>> {
    // generate unique trackingId in settings.json
    const settingsRes = await settingsUtil.readSettings(projectPath, false);
    if (settingsRes.isErr()) return err(settingsRes.error);
    const settings = settingsRes.value;
    if (settings.trackingId && !trackingId) return ok(settings.trackingId); // do nothing
    settings.trackingId = trackingId || uuid.v4();
    await settingsUtil.writeSettings(projectPath, settings);
    return ok(settings.trackingId);
  }

  async preProvisionForVS(
    ctx: DriverContext,
    inputs: InputsWithProjectPath
  ): Promise<
    Result<
      {
        needAzureLogin: boolean;
        needM365Login: boolean;
        resolvedAzureSubscriptionId?: string;
        resolvedAzureResourceGroupName?: string;
      },
      FxError
    >
  > {
    const res: {
      needAzureLogin: boolean;
      needM365Login: boolean;
      resolvedAzureSubscriptionId?: string;
      resolvedAzureResourceGroupName?: string;
    } = {
      needAzureLogin: false,
      needM365Login: false,
    };

    // 1. parse yml to cycles
    const templatePath =
      inputs["workflowFilePath"] || pathUtils.getYmlFilePath(ctx.projectPath, inputs.env);
    const maybeProjectModel = await metadataUtil.parse(templatePath, inputs.env);
    if (maybeProjectModel.isErr()) {
      return err(maybeProjectModel.error);
    }
    const projectModel = maybeProjectModel.value;
    const cycles: ILifecycle[] = [
      projectModel.registerApp,
      projectModel.provision,
      projectModel.configureApp,
    ].filter((c) => c !== undefined) as ILifecycle[];

    // 2. check each cycle
    for (const cycle of cycles) {
      const unresolvedPlaceholders = cycle.resolvePlaceholders();
      let firstArmDriver;
      for (const driver of cycle.driverDefs) {
        if (AzureActions.includes(driver.uses)) {
          res.needAzureLogin = true;
          if (!firstArmDriver) {
            firstArmDriver = driver;
          }
        }
        if (M365Actions.includes(driver.uses)) {
          res.needM365Login = true;
        }
      }
      if (firstArmDriver) {
        const withObj = firstArmDriver.with as any;
        res.resolvedAzureSubscriptionId = unresolvedPlaceholders.includes("AZURE_SUBSCRIPTION_ID")
          ? undefined
          : withObj["subscriptionId"];
        res.resolvedAzureResourceGroupName = unresolvedPlaceholders.includes(
          "AZURE_RESOURCE_GROUP_NAME"
        )
          ? undefined
          : withObj["resourceGroupName"];
      }
    }
    return ok(res);
  }

  async preCheckYmlAndEnvForVS(
    ctx: DriverContext,
    inputs: InputsWithProjectPath
  ): Promise<Result<Void, FxError>> {
    const templatePath =
      inputs["workflowFilePath"] || pathUtils.getYmlFilePath(ctx.projectPath, inputs.env);
    const maybeProjectModel = await metadataUtil.parse(templatePath, inputs.env);
    if (maybeProjectModel.isErr()) {
      return err(maybeProjectModel.error);
    }
    const projectModel = maybeProjectModel.value;
    const cycles: ILifecycle[] = [projectModel.provision].filter(
      (c) => c !== undefined
    ) as ILifecycle[];

    let unresolvedPlaceholders: string[] = [];
    // 2. check each cycle
    for (const cycle of cycles) {
      unresolvedPlaceholders = unresolvedPlaceholders.concat(cycle.resolvePlaceholders());
    }
    if (unresolvedPlaceholders.length > 0) {
      return err(new LifeCycleUndefinedError(unresolvedPlaceholders.join(",")));
    }
    return ok(Void);
  }

  @hooks([
    ActionExecutionMW({
      enableTelemetry: true,
      telemetryEventName: TelemetryEvent.Provision,
      telemetryComponentName: "coordinator",
    }),
  ])
  async provision(
    ctx: DriverContext,
    inputs: InputsWithProjectPath,
    actionContext?: ActionContext
  ): Promise<Result<DotenvParseOutput, FxError>> {
    const output: DotenvParseOutput = {};
    const folderName = path.parse(ctx.projectPath).name;

    // 1. parse yml
    const templatePath =
      inputs["workflowFilePath"] || pathUtils.getYmlFilePath(ctx.projectPath, inputs.env);
    const maybeProjectModel = await metadataUtil.parse(templatePath, inputs.env);
    if (maybeProjectModel.isErr()) {
      return err(maybeProjectModel.error);
    }
    const projectModel = maybeProjectModel.value;

    const cycles = [
      // projectModel.registerApp,
      projectModel.provision,
      // projectModel.configureApp,
    ].filter((c) => c !== undefined) as Lifecycle[];

    if (cycles.length === 0) {
      return err(new LifeCycleUndefinedError("provision"));
    }

    // 2. M365 sign in and tenant check if needed.
    let containsM365 = false;
    let containsAzure = false;
    const tenantSwitchCheckActions: string[] = [];
    cycles.forEach((cycle) => {
      cycle!.driverDefs?.forEach((def) => {
        if (M365Actions.includes(def.uses)) {
          containsM365 = true;
        } else if (AzureActions.includes(def.uses)) {
          containsAzure = true;
        }

        if (needTenantCheckActions.includes(def.uses)) {
          tenantSwitchCheckActions.push(def.uses);
        }
      });
    });

    let m365tenantInfo = undefined;
    if (containsM365) {
      const tenantInfoInTokenRes = await provisionUtils.getM365TenantId(ctx.m365TokenProvider);
      if (tenantInfoInTokenRes.isErr()) {
        return err(tenantInfoInTokenRes.error);
      }
      m365tenantInfo = tenantInfoInTokenRes.value;

      const checkM365TenatRes = await provisionUtils.ensureM365TenantMatchesV3(
        tenantSwitchCheckActions,
        m365tenantInfo?.tenantIdInToken
      );
      if (checkM365TenatRes.isErr()) {
        return err(checkM365TenatRes.error);
      }
    }

    // We will update targetResourceGroupInfo if creating resource group is needed and create the resource group later after confirming with the user
    let targetResourceGroupInfo: ResourceGroupInfo = {
      createNewResourceGroup: false,
      name: "",
      location: "",
    };

    let resolvedSubscriptionId: string | undefined;
    let resolvedResourceGroupName: string | undefined;
    let azureSubInfo = undefined;
    if (containsAzure) {
      //ensure RESOURCE_SUFFIX
      if (!process.env.RESOURCE_SUFFIX) {
        const suffix = process.env.RESOURCE_SUFFIX || uuid.v4().slice(0, 6);
        process.env.RESOURCE_SUFFIX = suffix;
        output.RESOURCE_SUFFIX = suffix;
      }
      // check whether placeholders are resolved
      let subscriptionUnresolved = false;
      let resourceGroupUnresolved = false;
      for (const cycle of cycles) {
        const unresolvedPlaceHolders = cycle.resolvePlaceholders();
        if (unresolvedPlaceHolders.includes("AZURE_SUBSCRIPTION_ID")) subscriptionUnresolved = true;
        else {
          cycle.driverDefs?.forEach((driver) => {
            const withObj = driver.with as any;
            if (withObj && withObj.subscriptionId && resolvedSubscriptionId === undefined)
              resolvedSubscriptionId = withObj.subscriptionId;
          });
        }
        if (unresolvedPlaceHolders.includes("AZURE_RESOURCE_GROUP_NAME"))
          resourceGroupUnresolved = true;
        else {
          cycle.driverDefs?.forEach((driver) => {
            const withObj = driver.with as any;
            if (withObj && withObj.resourceGroupName && resolvedResourceGroupName === undefined)
              resolvedResourceGroupName = withObj.resourceGroupName;
          });
        }
      }

      // ensure subscription, pop up UI to select if necessary
      if (subscriptionUnresolved) {
        if (inputs["targetSubscriptionId"]) {
          process.env.AZURE_SUBSCRIPTION_ID = inputs["targetSubscriptionId"];
          output.AZURE_SUBSCRIPTION_ID = inputs["targetSubscriptionId"];
        } else {
          const ensureRes = await provisionUtils.ensureSubscription(
            ctx.azureAccountProvider,
            undefined
          );
          if (ensureRes.isErr()) return err(ensureRes.error);
          const subInfo = ensureRes.value;
          if (subInfo && subInfo.subscriptionId) {
            process.env.AZURE_SUBSCRIPTION_ID = subInfo.subscriptionId;
            output.AZURE_SUBSCRIPTION_ID = subInfo.subscriptionId;
          }
        }
        resolvedSubscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
      }
      // ensure resource group
      if (resourceGroupUnresolved) {
        const inputRG = inputs["targetResourceGroupName"];
        const inputLocation = inputs["targetResourceLocationName"];
        if (inputRG && inputLocation) {
          // targetResourceGroupName is from VS inputs, which means create resource group if not exists
          targetResourceGroupInfo.name = inputRG;
          targetResourceGroupInfo.location = inputLocation;
          targetResourceGroupInfo.createNewResourceGroup = true; // create resource group if not exists
        } else {
          const defaultRg = `rg-${folderName}${process.env.RESOURCE_SUFFIX}-${inputs.env}`;
          const ensureRes = await provisionUtils.ensureResourceGroup(
            ctx.azureAccountProvider,
            resolvedSubscriptionId!,
            undefined,
            defaultRg
          );
          if (ensureRes.isErr()) return err(ensureRes.error);
          targetResourceGroupInfo = ensureRes.value;
          if (!targetResourceGroupInfo.createNewResourceGroup) {
            process.env.AZURE_RESOURCE_GROUP_NAME = targetResourceGroupInfo.name;
            output.AZURE_RESOURCE_GROUP_NAME = targetResourceGroupInfo.name;
          }
        }
        resolvedResourceGroupName = targetResourceGroupInfo.name;
      }

      // consent user
      await ctx.azureAccountProvider.getIdentityCredentialAsync(true); // make sure login if ensureSubScription() is not called.
      try {
        await ctx.azureAccountProvider.setSubscription(resolvedSubscriptionId!); //make sure sub is correctly set if ensureSubscription() is not called.
      } catch (e) {
        return err(assembleError(e));
      }
      azureSubInfo = await ctx.azureAccountProvider.getSelectedSubscription(false);
      if (!azureSubInfo) {
        return err(new SelectSubscriptionError());
      }
      const consentRes = await provisionUtils.askForProvisionConsentV3(
        ctx,
        m365tenantInfo,
        azureSubInfo,
        inputs.env
      );
      if (consentRes.isErr()) return err(consentRes.error);

      // create resource group if necessary
      if (targetResourceGroupInfo.createNewResourceGroup) {
        const createRgRes = await resourceGroupHelper.createNewResourceGroup(
          targetResourceGroupInfo.name,
          ctx.azureAccountProvider,
          resolvedSubscriptionId!,
          targetResourceGroupInfo.location
        );
        if (createRgRes.isErr()) {
          const error = createRgRes.error;
          if (!(error instanceof ResourceGroupConflictError)) {
            return err(error);
          }
        }
        process.env.AZURE_RESOURCE_GROUP_NAME = targetResourceGroupInfo.name;
        output.AZURE_RESOURCE_GROUP_NAME = targetResourceGroupInfo.name;
      }
    }

    // execute
    const summaryReporter = new SummaryReporter(cycles, ctx.logProvider);
    const steps = cycles.reduce((acc, cur) => acc + cur.driverDefs.length, 0);
    let hasError = false;
    try {
      ctx.progressBar = ctx.ui?.createProgressBar(
        getLocalizedString("core.progress.provision"),
        steps
      );
      await ctx.progressBar?.start();
      const maybeDescription = summaryReporter.getLifecycleDescriptions();
      if (maybeDescription.isErr()) {
        hasError = true;
        return err(maybeDescription.error);
      }
      ctx.logProvider.info(
        `Executing app registration and provision ${EOL}${EOL}${maybeDescription.value}${EOL}`
      );
      for (const [index, cycle] of cycles.entries()) {
        const execRes = await cycle.execute(ctx);
        summaryReporter.updateLifecycleState(index, execRes);
        const result = this.convertExecuteResult(execRes.result, templatePath);
        merge(output, result[0]);
        if (result[1]) {
          hasError = true;
          inputs.envVars = output;
          return err(result[1]);
        }
      }
    } finally {
      const summary = summaryReporter.getLifecycleSummary(inputs.createdEnvFile);
      ctx.logProvider.info(`Execution summary:${EOL}${EOL}${summary}${EOL}`);
      await ctx.progressBar?.end(!hasError);
    }

    // show provisioned resources
    const msg = getLocalizedString("core.common.LifecycleComplete.provision", steps, steps);
    if (azureSubInfo) {
      const url = getResourceGroupInPortal(
        azureSubInfo.subscriptionId,
        azureSubInfo.tenantId,
        resolvedResourceGroupName
      );
      if (url && ctx.platform !== Platform.CLI) {
        const title = getLocalizedString("core.provision.viewResources");
        ctx.ui?.showMessage("info", msg, false, title).then((result: any) => {
          const userSelected = result.isOk() ? result.value : undefined;
          if (userSelected === title) {
            ctx.ui?.openUrl(url);
          }
        });
      } else {
        if (url && ctx.platform === Platform.CLI) {
          ctx.ui?.showMessage(
            "info",
            [
              {
                content: `${msg} View the provisioned resources from `,
                color: Colors.BRIGHT_GREEN,
              },
              {
                content: url,
                color: Colors.BRIGHT_CYAN,
              },
            ],
            false
          );
        } else {
          ctx.ui?.showMessage("info", msg, false);
        }
      }
    } else {
      if (ctx.platform === Platform.VS) {
        ctx.ui!.showMessage(
          "info",
          getLocalizedString("core.common.LifecycleComplete.prepareTeamsApp"),
          false
        );
      } else {
        ctx.ui!.showMessage("info", msg, false);
      }
    }
    ctx.logProvider.info(msg);

    return ok(output);
  }

  convertExecuteResult(
    execRes: Result<ExecutionOutput, ExecutionError>,
    templatePath: string
  ): [DotenvParseOutput, FxError | undefined] {
    const output: DotenvParseOutput = {};
    let error = undefined;
    if (execRes.isErr()) {
      const execError = execRes.error;
      if (execError.kind === "Failure") {
        error = execError.error;
      } else {
        const partialOutput = execError.env;
        const newOutput = envUtil.map2object(partialOutput);
        merge(output, newOutput);
        const reason = execError.reason;
        if (reason.kind === "DriverError") {
          error = reason.error;
        } else if (reason.kind === "UnresolvedPlaceholders") {
          const placeholders = reason.unresolvedPlaceHolders?.join(",") || "";
          error = new MissingEnvironmentVariablesError(
            camelCase(reason.failedDriver.uses),
            placeholders,
            templatePath
          );
        }
      }
    } else {
      const newOutput = envUtil.map2object(execRes.value);
      merge(output, newOutput);
    }
    return [output, error];
  }

  @hooks([
    ActionExecutionMW({
      enableTelemetry: true,
      telemetryEventName: TelemetryEvent.Deploy,
      telemetryComponentName: "coordinator",
    }),
  ])
  async deploy(
    ctx: DriverContext,
    inputs: InputsWithProjectPath,
    actionContext?: ActionContext
  ): Promise<Result<DotenvParseOutput, FxError>> {
    const output: DotenvParseOutput = {};
    const templatePath =
      inputs["workflowFilePath"] || pathUtils.getYmlFilePath(ctx.projectPath, inputs.env);
    const maybeProjectModel = await metadataUtil.parse(templatePath, inputs.env);
    if (maybeProjectModel.isErr()) {
      return err(maybeProjectModel.error);
    }
    const projectModel = maybeProjectModel.value;
    if (projectModel.deploy) {
      //check whether deploy to azure
      let containsAzure = false;
      projectModel.deploy.driverDefs?.forEach((def) => {
        if (AzureDeployActions.includes(def.uses)) {
          containsAzure = true;
        }
      });

      //consent
      if (containsAzure) {
        const consent = await deployUtils.askForDeployConsentV3(ctx);
        if (consent.isErr()) {
          return err(consent.error);
        }
      }

      const summaryReporter = new SummaryReporter([projectModel.deploy], ctx.logProvider);
      let hasError = false;
      try {
        const steps = projectModel.deploy.driverDefs.length;
        ctx.progressBar = ctx.ui?.createProgressBar(
          getLocalizedString("core.progress.deploy"),
          steps
        );
        await ctx.progressBar?.start();
        const maybeDescription = summaryReporter.getLifecycleDescriptions();
        if (maybeDescription.isErr()) {
          return err(maybeDescription.error);
        }
        ctx.logProvider.info(`Executing deploy ${EOL}${EOL}${maybeDescription.value}${EOL}`);
        const execRes = await projectModel.deploy.execute(ctx);
        summaryReporter.updateLifecycleState(0, execRes);
        const result = this.convertExecuteResult(execRes.result, templatePath);
        merge(output, result[0]);
        if (result[1]) {
          hasError = true;
          inputs.envVars = output;
          return err(result[1]);
        }

        // show message box after deploy
        const botTroubleShootMsg = getBotTroubleShootMessage(false);
        const msg =
          getLocalizedString("core.common.LifecycleComplete.deploy", steps, steps) +
          botTroubleShootMsg.textForLogging;
        if (ctx.platform !== Platform.VS) {
          ctx.ui?.showMessage("info", msg, false);
        }
      } finally {
        const summary = summaryReporter.getLifecycleSummary();
        ctx.logProvider.info(`Execution summary:${EOL}${EOL}${summary}${EOL}`);
        await ctx.progressBar?.end(!hasError);
      }
    } else {
      return err(new LifeCycleUndefinedError("deploy"));
    }
    return ok(output);
  }

  @hooks([
    ActionExecutionMW({
      enableTelemetry: true,
      telemetryEventName: "publish",
      telemetryComponentName: "coordinator",
    }),
  ])
  async publish(
    ctx: DriverContext,
    inputs: InputsWithProjectPath,
    actionContext?: ActionContext
  ): Promise<Result<DotenvParseOutput, FxError>> {
    const output: DotenvParseOutput = {};
    const templatePath = pathUtils.getYmlFilePath(ctx.projectPath, inputs.env);
    const maybeProjectModel = await metadataUtil.parse(templatePath, inputs.env);
    if (maybeProjectModel.isErr()) {
      return err(maybeProjectModel.error);
    }
    const projectModel = maybeProjectModel.value;
    let hasError = false;
    if (projectModel.publish) {
      const summaryReporter = new SummaryReporter([projectModel.publish], ctx.logProvider);
      try {
        const steps = projectModel.publish.driverDefs.length;
        ctx.progressBar = ctx.ui?.createProgressBar(
          getLocalizedString("core.progress.publish"),
          steps
        );
        await ctx.progressBar?.start();
        const maybeDescription = summaryReporter.getLifecycleDescriptions();
        if (maybeDescription.isErr()) {
          hasError = true;
          return err(maybeDescription.error);
        }
        ctx.logProvider.info(`Executing publish ${EOL}${EOL}${maybeDescription.value}${EOL}`);

        const execRes = await projectModel.publish.execute(ctx);
        const result = this.convertExecuteResult(execRes.result, templatePath);
        merge(output, result[0]);
        summaryReporter.updateLifecycleState(0, execRes);
        if (result[1]) {
          hasError = true;
          inputs.envVars = output;
          return err(result[1]);
        } else {
          const msg = getLocalizedString("core.common.LifecycleComplete.publish", steps, steps);
          const adminPortal = getLocalizedString("plugins.appstudio.adminPortal");
          if (ctx.platform !== Platform.CLI) {
            ctx.ui?.showMessage("info", msg, false, adminPortal).then((value) => {
              if (value.isOk() && value.value === adminPortal) {
                ctx.ui!.openUrl(Constants.TEAMS_ADMIN_PORTAL);
              }
            });
          } else {
            ctx.ui?.showMessage("info", msg, false);
          }
        }
      } finally {
        const summary = summaryReporter.getLifecycleSummary();
        ctx.logProvider.info(`Execution summary:${EOL}${EOL}${summary}${EOL}`);
        await ctx.progressBar?.end(!hasError);
      }
    } else {
      return err(new LifeCycleUndefinedError("publish"));
    }
    return ok(output);
  }

  @hooks([
    ActionExecutionMW({
      enableTelemetry: true,
      telemetryEventName: TelemetryEvent.PublishInDeveloperPortal,
      telemetryComponentName: "coordinator",
      errorSource: CoordinatorSource,
    }),
  ])
  async publishInDeveloperPortal(
    ctx: Context,
    inputs: InputsWithProjectPath,
    actionContext?: ActionContext
  ): Promise<Result<Void, FxError>> {
    // update teams app
    if (!ctx.tokenProvider) {
      return err(new ObjectIsUndefinedError("tokenProvider"));
    }
    if (!inputs[QuestionNames.AppPackagePath]) {
      return err(new ObjectIsUndefinedError("appPackagePath"));
    }
    const updateRes = await updateTeamsAppV3ForPublish(ctx, inputs);

    if (updateRes.isErr()) {
      return err(updateRes.error);
    }
    let loginHint = "";
    const accountRes = await ctx.tokenProvider.m365TokenProvider.getJsonObject({
      scopes: AppStudioScopes,
    });
    if (accountRes.isOk()) {
      loginHint = accountRes.value.unique_name as string;
    }
    await ctx.userInteraction.openUrl(
      `https://dev.teams.microsoft.com/apps/${updateRes.value}/distributions/app-catalog?login_hint=${loginHint}&referrer=teamstoolkit_${inputs.platform}`
    );
    return ok(Void);
  }
}

export const coordinator = new Coordinator();

interface BotTroubleShootMessage {
  troubleShootLink: string;
  textForLogging: string;
  textForMsgBox: string;
  textForActionButton: string;
}

function getBotTroubleShootMessage(isBot: boolean): BotTroubleShootMessage {
  const botTroubleShootLink =
    "https://aka.ms/teamsfx-bot-help#how-can-i-troubleshoot-issues-when-teams-bot-isnt-responding-on-azure";
  const botTroubleShootDesc = getLocalizedString("core.deploy.botTroubleShoot");
  const botTroubleShootLearnMore = getLocalizedString("core.deploy.botTroubleShoot.learnMore");
  const botTroubleShootMsg = `${botTroubleShootDesc} ${botTroubleShootLearnMore}: ${botTroubleShootLink}.`;

  return {
    troubleShootLink: botTroubleShootLink,
    textForLogging: isBot ? botTroubleShootMsg : "",
    textForMsgBox: botTroubleShootDesc,
    textForActionButton: botTroubleShootLearnMore,
  } as BotTroubleShootMessage;
}

async function downloadSampleHook(sampleId: string, sampleAppPath: string): Promise<void> {
  // A temporary solution to avoid duplicate componentId
  if (sampleId === "todo-list-SPFx") {
    const originalId = "c314487b-f51c-474d-823e-a2c3ec82b1ff";
    const componentId = uuid.v4();
    glob.glob(`${sampleAppPath}/**/*.json`, { nodir: true, dot: true }, async (err, files) => {
      await Promise.all(
        files.map(async (file) => {
          let content = (await fs.readFile(file)).toString();
          const reg = new RegExp(originalId, "g");
          content = content.replace(reg, componentId);
          await fs.writeFile(file, content);
        })
      );
    });
  }
}
