connection: "my_bq"

include: "views/shared_dims.view.lkml"
include: "views/campaigns.view.lkml"

explore: campaigns {
  join: shared_dims {
    relationship: many_to_one
    sql_on: ${campaigns.region_id} = ${shared_dims.id} ;;
  }
}
